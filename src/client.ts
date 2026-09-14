import type { PushrChannelAuth, PushrClientOptions, PushrConnectSignature, PushrServerMessage } from './types.js';
import { PushrError, normalizeError } from './errors.js';
import { backoff, bounded, channelSnapshot, timingOptions } from './lifecycle.js';

type Listener = (payload: any) => void;
type Session = {
  generation: number;
  controller: AbortController;
  ws: WebSocket | null;
  socketId: string | null;
  phase: 'signature' | 'open' | 'connection';
  timer?: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: PushrError) => void;
};

export class PushrClient {
  private session: Session | null = null;
  private generation = 0;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly channelListeners = new Map<string, Map<string, Set<Listener>>>();
  readonly timing: ReturnType<typeof timingOptions>;

  constructor(private readonly options: PushrClientOptions) {
    this.timing = timingOptions(options);
  }

  /** Resolves at protocol readiness, not WebSocket open. Concurrent callers share this attempt. */
  connect(): Promise<void> {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.session) return this.session.promise;

    let resolve!: () => void;
    let reject!: (error: PushrError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const session: Session = {
      generation: ++this.generation, controller: new AbortController(), ws: null,
      socketId: null, phase: 'signature', promise, resolve, reject,
    };
    this.session = session;
    // Mark the original promise handled for automatic attempts, while explicit callers still receive rejection.
    void promise.catch(error => {
      if (error.kind !== 'cancelled' && !this.stopped && this.generation === session.generation) this.report(error);
    });
    session.timer = setTimeout(() => this.fail(session, new PushrError('timeout', session.phase)), this.timing.connectTimeoutMs);
    void Promise.resolve().then(() => {
      if (this.session !== session) return;
      return this.options.getConnectSignature(session.controller.signal);
    }).then(signature => {
      if (this.session !== session) return;
      const url = this.buildUrl(signature);
      session.phase = 'open';
      const ws = (this.options.webSocketFactory ?? (address => new WebSocket(address)))(url);
      // A synchronous adapter may have called disconnect while constructing the socket.
      if (this.session !== session) { ws.close(); return; }
      session.ws = ws;
      ws.onopen = () => {
        if (this.session !== session) return;
        clearTimeout(session.timer);
        session.phase = 'connection';
        session.timer = setTimeout(() => this.fail(session, new PushrError('timeout', 'connection')), this.timing.connectionTimeoutMs);
      };
      ws.onmessage = event => {
        if (this.session === session) this.handleMessage(session, event.data);
      };
      ws.onerror = () => this.fail(session, new PushrError('network', session.phase));
      ws.onclose = () => this.fail(session, new PushrError('network', session.phase));
    }).catch(error => this.fail(session, normalizeError(error, session.phase)));
    return promise;
  }

  /** Used by acquired subscriptions: neither supersede backoff nor reopen a manually stopped client. */
  start(): void {
    if (!this.stopped && !this.session && this.reconnectTimer === undefined) void this.connect();
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.retries = 0;
    if (this.session) this.fail(this.session, new PushrError('cancelled', 'connection'));
    else this.emit('disconnect', { manual: true });
  }

  isConnected(): boolean {
    return this.session?.socketId !== null && this.session?.socketId !== undefined && this.session.ws?.readyState === 1;
  }

  getGeneration(): number { return this.generation; }

  getSocketId(): string {
    if (!this.isConnected()) throw new PushrError('network', 'connection');
    return this.session!.socketId!;
  }

  /** Low-level one-shot command. Completion means sent, not acknowledged; it does not retain ownership. */
  async subscribe(channel: string, channelData?: unknown, signal?: AbortSignal): Promise<void> {
    const generation = this.getGeneration();
    const auth = this.requiresChannelAuth(channel) ? await this.authorizeChannel(channel, channelData, signal) : undefined;
    if (signal?.aborted || generation !== this.getGeneration()) throw new PushrError('cancelled', 'subscribe', undefined, channel);
    this.sendSubscribe(channel, auth);
  }

  sendSubscribe(channel: string, auth?: PushrChannelAuth): void {
    this.send({ type: 'subscribe', channel, auth: auth?.auth, channel_data: auth?.channelData });
  }

  unsubscribe(channel: string): void { this.send({ type: 'unsubscribe', channel }); }

  async publish(channel: string, event: string, data?: unknown): Promise<void> {
    const generation = this.getGeneration();
    const auth = this.requiresChannelAuth(channel) ? await this.authorizeChannel(channel) : undefined;
    if (generation !== this.getGeneration()) throw new PushrError('cancelled', 'publish', undefined, channel);
    this.send({ type: 'publish', channel, event, data, auth: auth?.auth, channel_data: auth?.channelData });
  }

  async authorizeChannel(channel: string, channelData?: unknown, signal?: AbortSignal): Promise<PushrChannelAuth> {
    const session = this.session;
    const socketId = this.getSocketId();
    if (!this.options.getChannelAuth) throw new PushrError('configuration', 'auth', undefined, channel);
    try {
      const auth = await bounded(
        abort => this.options.getChannelAuth!(channel, socketId, channelData, abort),
        this.timing.authTimeoutMs,
        [session!.controller.signal, ...(signal ? [signal] : [])], 'auth', channel,
      );
      if (this.session !== session || signal?.aborted) throw new PushrError('cancelled', 'auth', undefined, channel);
      if (!auth || typeof auth.auth !== 'string' || auth.auth.trim() === '') throw new PushrError('protocol', 'auth', undefined, channel);
      try {
        return { auth: auth.auth, channelData: channelSnapshot(auth.channelData).data };
      } catch { throw new PushrError('protocol', 'auth', undefined, channel); }
    } catch (error) {
      throw normalizeError(error, 'auth', channel);
    }
  }

  requiresChannelAuth(channel: string): boolean { return channel.startsWith('private.') || channel.startsWith('presence.'); }

  on<T = unknown>(type: string, listener: (payload: T) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  off<T = unknown>(type: string, listener: (payload: T) => void): void {
    const set = this.listeners.get(type);
    set?.delete(listener);
    if (set?.size === 0) this.listeners.delete(type);
  }

  onEvent(channel: string, event: string, listener: Listener): void {
    const map = this.channelListeners.get(channel) ?? new Map();
    const set = map.get(event) ?? new Set();
    set.add(listener);
    map.set(event, set);
    this.channelListeners.set(channel, map);
  }

  offEvent(channel: string, event: string, listener: Listener): void {
    const map = this.channelListeners.get(channel);
    const set = map?.get(event);
    set?.delete(listener);
    if (set?.size === 0) map?.delete(event);
    if (map?.size === 0) this.channelListeners.delete(channel);
  }

  report(error: PushrError): void { this.emit('error', error); }

  private fail(session: Session, error: PushrError): void {
    if (this.session !== session) return;
    const wasReady = session.socketId !== null;
    this.session = null;
    clearTimeout(session.timer);
    session.controller.abort();
    if (session.ws) {
      session.ws.onopen = session.ws.onmessage = session.ws.onerror = session.ws.onclose = null;
      try { session.ws.close(); } catch { /* The transport is already detached and its failure is reported below. */ }
    }
    session.reject(error);
    if (!this.stopped && this.options.autoReconnect) {
      const delay = backoff(this.retries++, this.timing, this.options.random ?? Math.random);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.stopped) void this.connect();
      }, delay);
    }
    this.emit('disconnect', { manual: this.stopped });
    if (wasReady && error.kind !== 'cancelled') this.report(error);
  }

  private handleMessage(session: Session, raw: unknown): void {
    let message: PushrServerMessage;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : '');
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error();
    } catch {
      this.report(new PushrError('protocol', 'connection'));
      return;
    }
    if (message.type === 'connection') {
      if (session.phase !== 'connection' || typeof message.socket_id !== 'string' || !message.socket_id.trim()
        || typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
        this.fail(session, new PushrError('protocol', 'connection'));
        return;
      }
      if (session.socketId !== null) {
        if (session.socketId !== message.socket_id) this.fail(session, new PushrError('protocol', 'connection'));
        return;
      }
      session.socketId = message.socket_id;
      clearTimeout(session.timer);
      this.retries = 0;
      session.resolve();
      this.emit('connection', message);
      return;
    }
    if (message.type === 'error') {
      this.report(new PushrError('protocol', 'connection'));
      return;
    }
    if (!session.socketId || !('channel' in message) || typeof message.channel !== 'string') {
      this.report(new PushrError('protocol', 'connection'));
      return;
    }
    if (message.type === 'event' && typeof message.event === 'string') {
      this.emit('event', message);
      if (this.session === session) this.deliver(this.channelListeners.get(message.channel)?.get(message.event), message.data);
    } else if (message.type === 'subscribed' || message.type === 'unsubscribed') {
      this.emit(message.type, message);
    } else this.report(new PushrError('protocol', 'connection'));
  }

  private emit(type: string, payload: unknown): void { this.deliver(this.listeners.get(type), payload, type === 'error'); }

  private deliver(listeners: Set<Listener> | undefined, payload: unknown, reporting = false): void {
    for (const listener of [...(listeners ?? [])]) {
      if (!listeners?.has(listener)) continue;
      try { listener(payload); } catch {
        if (!reporting) this.report(new PushrError('listener', 'listener'));
        else console.error('Pushr error observer failed.');
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.isConnected()) throw new PushrError('network', 'connection');
    const session = this.session!;
    try { session.ws!.send(JSON.stringify(payload)); } catch {
      const error = new PushrError('network', 'connection');
      this.fail(session, error);
      throw error;
    }
  }

  private buildUrl(signature: PushrConnectSignature | undefined): string {
    if (!signature || typeof signature.appId !== 'string' || !signature.appId
      || typeof signature.signature !== 'string' || !signature.signature
      || typeof signature.timestamp !== 'number' || !Number.isFinite(signature.timestamp)
      || (signature.url !== undefined && typeof signature.url !== 'string')) throw new PushrError('protocol', 'signature');
    try {
      const url = new URL(signature.url ?? this.options.url);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error();
      url.searchParams.set('app_id', signature.appId);
      url.searchParams.set('timestamp', String(signature.timestamp));
      url.searchParams.set('signature', signature.signature);
      return url.toString();
    } catch { throw new PushrError('configuration', 'signature'); }
  }
}
