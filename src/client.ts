import type { PushrChannelAuth, PushrClientOptions, PushrConnectSignature, PushrServerMessage } from './types';

type Listener<T = unknown> = (payload: T) => void;

type ListenerMap = Map<string, Set<Listener>>;

type ChannelListenerMap = Map<string, Map<string, Set<Listener>>>;

export class PushrClient {
  private ws: WebSocket | null = null;
  private socketId: string | null = null;
  private listeners: ListenerMap = new Map();
  private channelListeners: ChannelListenerMap = new Map();
  private reconnectTimer: number | null = null;

  constructor(private readonly options: PushrClientOptions) {}

  async connect(): Promise<void> {
    this.socketId = null;

    const signature = await this.options.getConnectSignature();
    const url = this.buildUrl(signature);

    this.ws = new WebSocket(url);
    this.ws.onmessage = (event) => this.handleMessage(event.data);
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = () => this.emit('error', { message: 'WebSocket error' });

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket is not initialized'));
        return;
      }

      const ws = this.ws;
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        ws.removeEventListener('open', onOpen);
        reject(new Error('WebSocket connection failed'));
      };

      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async subscribe(channel: string, channelData?: unknown): Promise<void> {
    const payload: Record<string, unknown> = {
      type: 'subscribe',
      channel,
    };

    if (this.requiresChannelAuth(channel)) {
      const socketId = await this.resolveSocketId();
      const auth = await this.resolveChannelAuth(channel, socketId, channelData);
      payload.auth = auth.auth;
      if (auth.channelData !== undefined) {
        payload.channel_data = auth.channelData;
      }
    }

    this.send(payload);
  }

  unsubscribe(channel: string): void {
    this.send({ type: 'unsubscribe', channel });
  }

  async publish(channel: string, event: string, data?: unknown): Promise<void> {
    const payload: Record<string, unknown> = {
      type: 'publish',
      channel,
      event,
      data,
    };

    if (this.requiresChannelAuth(channel)) {
      const socketId = await this.resolveSocketId();
      const auth = await this.resolveChannelAuth(channel, socketId);
      payload.auth = auth.auth;
      if (auth.channelData !== undefined) {
        payload.channel_data = auth.channelData;
      }
    }

    this.send(payload);
  }

  on<T = unknown>(type: string, listener: Listener<T>): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as Listener);
    this.listeners.set(type, set);
  }

  off<T = unknown>(type: string, listener: Listener<T>): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }
    set.delete(listener as Listener);
  }

  onEvent(channel: string, event: string, listener: Listener): void {
    const channelMap = this.channelListeners.get(channel) ?? new Map();
    const eventSet = channelMap.get(event) ?? new Set();
    eventSet.add(listener);
    channelMap.set(event, eventSet);
    this.channelListeners.set(channel, channelMap);
  }

  offEvent(channel: string, event: string, listener: Listener): void {
    const channelMap = this.channelListeners.get(channel);
    const eventSet = channelMap?.get(event);
    eventSet?.delete(listener);
  }

  getSocketId(): string {
    if (!this.socketId) {
      throw new Error('Socket ID is not available yet. Wait for connection event.');
    }

    return this.socketId;
  }

  private handleMessage(raw: string): void {
    let message: PushrServerMessage | null = null;
    try {
      message = JSON.parse(raw) as PushrServerMessage;
    } catch {
      this.emit('error', { message: 'Invalid JSON from server' });
      return;
    }

    if (message.type === 'connection') {
      this.socketId = message.socket_id;
      this.emit('connection', message);
      return;
    }

    if (message.type === 'event') {
      this.emit('event', message);
      this.emitChannelEvent(message.channel, message.event, message.data);
      return;
    }

    this.emit(message.type, message);
  }

  private handleClose(): void {
    this.socketId = null;
    this.emit('disconnect', {});
    if (this.options.autoReconnect) {
      const delay = this.options.reconnectDelayMs ?? 2000;
      this.reconnectTimer = window.setTimeout(() => {
        void this.connect();
      }, delay);
    }
  }

  private emit<T = unknown>(type: string, payload: T): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }

    set.forEach((listener) => listener(payload));
  }

  private emitChannelEvent(channel: string, event: string, data?: unknown): void {
    const channelMap = this.channelListeners.get(channel);
    const eventSet = channelMap?.get(event);
    if (!eventSet) {
      return;
    }

    eventSet.forEach((listener) => listener(data));
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws) {
      throw new Error('WebSocket is not connected.');
    }

    this.ws.send(JSON.stringify(payload));
  }

  private async resolveSocketId(timeoutMs = 10000): Promise<string> {
    if (this.socketId) {
      return this.socketId;
    }

    const socketIdUnavailableMessage = 'Socket ID is not available yet. Wait for connection event.';

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: number | null = null;

      const cleanup = (): void => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }

        this.off('connection', onConnection);
        this.off('error', onError);
        this.off('disconnect', onDisconnect);
      };

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        callback();
      };

      const onConnection = (): void => {
        finish(resolve);
      };

      const onDisconnect = (): void => {
        finish(() => reject(new Error('WebSocket disconnected before socket id was received.')));
      };

      const onError = (payload: unknown): void => {
        const message =
          payload !== null &&
          typeof payload === 'object' &&
          'message' in payload &&
          typeof (payload as { message?: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : 'WebSocket error';

        finish(() => reject(new Error(message)));
      };

      this.on('connection', onConnection);
      this.on('error', onError);
      this.on('disconnect', onDisconnect);

      timeoutId = window.setTimeout(() => {
        finish(() => reject(new Error(socketIdUnavailableMessage)));
      }, timeoutMs);
    });

    if (!this.socketId) {
      throw new Error(socketIdUnavailableMessage);
    }

    return this.socketId;
  }

  private async resolveChannelAuth(
    channel: string,
    socketId: string,
    channelData?: unknown
  ): Promise<PushrChannelAuth> {
    if (!this.options.getChannelAuth) {
      throw new Error('getChannelAuth is not configured for private channels.');
    }

    const auth = await this.options.getChannelAuth(channel, socketId, channelData);
    return auth;
  }

  private buildUrl(signature: PushrConnectSignature): string {
    const baseUrl = signature.url ?? this.options.url;
    const separator = baseUrl.includes('?') ? '&' : '?';

    return (
      baseUrl +
      separator +
      `app_id=${encodeURIComponent(signature.appId)}` +
      `&timestamp=${encodeURIComponent(signature.timestamp)}` +
      `&signature=${encodeURIComponent(signature.signature)}`
    );
  }

  private requiresChannelAuth(channel: string): boolean {
    return (
      channel.startsWith('private.') ||
      channel.startsWith('presence.')
    );
  }
}
