import { PushrClient } from './client.js';
import { PushrError, PushrHttpError, isTransient, normalizeError } from './errors.js';
import { backoff, channelSnapshot, timingOptions } from './lifecycle.js';
import type { PushrChannelAuth, PushrClientOptions, PushrConnectSignature, PushrEventMessage, PushrTimingOptions } from './types.js';

export type PushrConfig = { url?: string; connect?: string; auth?: string };
export type PushrServiceRequest = {
  get: (url: string, signal: AbortSignal) => Promise<unknown>;
  post: (url: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
};
export type PushrServiceOptions = PushrTimingOptions & {
  resolveConfig?: () => Partial<PushrConfig>;
  request?: PushrServiceRequest;
  autoReconnect?: boolean;
  random?: () => number;
  webSocketFactory?: PushrClientOptions['webSocketFactory'];
  onError?: (error: PushrError) => void;
};
export type PushrSubscriptionState = 'waiting-connection' | 'authorizing' | 'waiting-subscribed'
  | 'subscribed' | 'retry-wait' | 'paused' | 'waiting-unsubscribed' | 'unknown' | 'released';
export type PushrSubscriptionSnapshot = Readonly<{ state: PushrSubscriptionState; error?: PushrError }>;
export type PushrSubscription = {
  getSnapshot: () => PushrSubscriptionSnapshot;
  observe: (listener: (snapshot: PushrSubscriptionSnapshot) => void) => () => void;
  onEvent: (event: string, listener: (data: unknown) => void) => () => void;
  retry: () => PushrSubscriptionSnapshot;
  release: () => void;
};
export type PushrService = {
  getClient: () => PushrClient;
  ensureConnected: () => Promise<PushrClient>;
  acquireChannel: (channel: string, channelData?: unknown) => PushrSubscription;
  disconnect: () => void;
};
type Owner = {
  released: boolean;
  observers: Set<(snapshot: PushrSubscriptionSnapshot) => void>;
  events: Map<string, Set<(payload: unknown) => void>>;
};
type Cycle = {
  owners: Set<Owner>; key: string; data: unknown; snapshot: PushrSubscriptionSnapshot;
  paused: boolean; sent: number | null; abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>; retries: number;
};
type Barrier = { generation: number; timer?: ReturnType<typeof setTimeout>; error?: PushrError };
type Entry = { channel: string; cycle: Cycle | null; barrier?: Barrier };

const defaultResolveConfig = (): PushrConfig => {
  if (typeof window === 'undefined') return {};
  const config = (window as { __APP_CONFIG__?: { app?: { pushr?: PushrConfig }; pushr?: PushrConfig } }).__APP_CONFIG__;
  return config?.app?.pushr ?? config?.pushr ?? {};
};
const readResponse = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new PushrHttpError(response.status);
  try { return await response.json(); } catch { throw new PushrError('protocol', 'auth'); }
};
const defaultRequest: PushrServiceRequest = {
  get: async (url, signal) => readResponse(await fetch(url, {
    signal, credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  })),
  post: async (url, body, signal) => readResponse(await fetch(url, {
    signal, method: 'POST', credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body),
  })),
};

export const createPushrService = (options: PushrServiceOptions = {}): PushrService => {
  let client: PushrClient | null = null;
  const entries = new Map<string, Entry>();
  const request = options.request ?? defaultRequest;
  const timing = timingOptions(options);
  const safeCall = <T>(listener: (value: T) => void, value: T): void => {
    try { listener(value); } catch { console.error('Pushr observer failed.'); }
  };
  const notify = (cycle: Cycle, state: PushrSubscriptionState, error?: PushrError): void => {
    cycle.snapshot = Object.freeze({ state, ...(error ? { error } : {}) });
    for (const owner of [...cycle.owners]) {
      for (const observer of [...owner.observers]) {
        if (!owner.released && owner.observers.has(observer)) safeCall(observer, cycle.snapshot);
      }
    }
  };
  const cancel = (cycle: Cycle): void => {
    clearTimeout(cycle.timer);
    cycle.timer = undefined;
    cycle.abort?.abort();
    cycle.abort = undefined;
  };
  const report = (error: PushrError): void => { if (options.onError) safeCall(options.onError, error); };
  const resetGeneration = (): void => {
    for (const entry of [...entries.values()]) {
      clearTimeout(entry.barrier?.timer);
      entry.barrier = undefined;
      const cycle = entry.cycle;
      if (!cycle) { entries.delete(entry.channel); continue; }
      cancel(cycle);
      cycle.sent = null;
      cycle.retries = 0;
      if (!cycle.paused) notify(cycle, 'waiting-connection');
    }
  };
  const getClient = (): PushrClient => {
    if (client) return client;
    const config = { ...defaultResolveConfig(), ...options.resolveConfig?.() };
    let url = config.url ?? (typeof window !== 'undefined' ? window.location.origin : '');
    url = url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    if (typeof window !== 'undefined' && window.location.protocol === 'https:') url = url.replace(/^ws:/i, 'wss:');
    if (!url) throw new PushrError('configuration', 'connection');
    const instance = new PushrClient({
      ...options, url, autoReconnect: options.autoReconnect ?? true,
      getConnectSignature: async signal => await request.get(config.connect ?? '/broadcast/connect', signal) as PushrConnectSignature,
      getChannelAuth: async (channel, socketId, data, signal) => await request.post(config.auth ?? '/broadcast/auth', {
        socket_id: socketId, channel, channel_data: data,
      }, signal) as PushrChannelAuth,
    });
    client = instance;
    instance.on('connection', () => {
      if (client !== instance) return;
      for (const entry of [...entries.values()]) startCycle(entry);
    });
    instance.on('disconnect', () => { if (client === instance) resetGeneration(); });
    instance.on<PushrError>('error', error => {
      if (client !== instance) return;
      report(error);
      for (const entry of [...entries.values()]) {
        if (entry.cycle) notify(entry.cycle, entry.cycle.snapshot.state, error);
      }
    });
    instance.on<{ channel: string }>('subscribed', ({ channel }) => {
      if (client !== instance) return;
      const entry = entries.get(channel);
      const cycle = entry?.cycle;
      if (!cycle || entry?.barrier || cycle.sent !== instance.getGeneration()) return;
      clearTimeout(cycle.timer);
      cycle.timer = undefined;
      notify(cycle, 'subscribed');
    });
    instance.on<{ channel: string }>('unsubscribed', ({ channel }) => {
      if (client !== instance) return;
      const entry = entries.get(channel);
      if (!entry?.barrier || entry.barrier.generation !== instance.getGeneration()) return;
      clearTimeout(entry.barrier.timer);
      entry.barrier = undefined;
      if (entry.cycle) startCycle(entry);
      else entries.delete(channel);
    });
    instance.on<PushrEventMessage>('event', message => {
      if (client !== instance) return;
      const entry = entries.get(message.channel);
      const cycle = entry?.cycle;
      if (!cycle || entry?.barrier || cycle.snapshot.state !== 'subscribed') return;
      for (const owner of [...cycle.owners]) {
        for (const listener of [...(owner.events.get(message.event) ?? [])]) {
          if (!owner.released && owner.events.get(message.event)?.has(listener)) safeCall(listener, message.data);
        }
      }
    });
    return instance;
  };

  const startCycle = (entry: Entry): void => {
    const cycle = entry.cycle;
    if (!cycle || cycle.owners.size === 0 || cycle.paused || cycle.abort || cycle.timer || cycle.sent !== null) return;
    if (entry.barrier) {
      notify(cycle, entry.barrier.error ? 'unknown' : 'waiting-unsubscribed', entry.barrier.error);
      return;
    }
    const instance = getClient();
    if (!instance.isConnected()) { notify(cycle, 'waiting-connection'); return; }
    const generation = instance.getGeneration();
    const controller = new AbortController();
    cycle.abort = controller;
    const active = (): boolean => entry.cycle === cycle && cycle.owners.size > 0 && !controller.signal.aborted
      && client === instance && instance.isConnected() && instance.getGeneration() === generation;
    const run = async (): Promise<void> => {
      let auth: PushrChannelAuth | undefined;
      if (instance.requiresChannelAuth(entry.channel)) {
        notify(cycle, 'authorizing');
        if (!active()) return;
        auth = await instance.authorizeChannel(entry.channel, channelSnapshot(cycle.data).data, controller.signal);
      }
      if (!active()) return;
      cycle.retries = 0;
      cycle.sent = generation;
      cycle.abort = undefined;
      cycle.timer = setTimeout(() => {
        cycle.timer = undefined;
        if (entry.cycle === cycle && cycle.sent === instance.getGeneration() && client === instance) {
          const error = new PushrError('timeout', 'subscribe', undefined, entry.channel);
          notify(cycle, 'unknown', error);
          report(error);
        }
      }, timing.subscribeTimeoutMs);
      instance.sendSubscribe(entry.channel, auth);
      if (entry.cycle === cycle && cycle.snapshot.state !== 'subscribed' && instance.isConnected()) notify(cycle, 'waiting-subscribed');
    };
    void run().catch(raw => {
      if (!active()) return;
      cycle.abort = undefined;
      const error = normalizeError(raw, 'auth', entry.channel);
      if (error.kind === 'cancelled') return;
      if (isTransient(error)) {
        cycle.timer = setTimeout(() => { cycle.timer = undefined; startCycle(entry); }, backoff(cycle.retries++, timing, options.random ?? Math.random));
        notify(cycle, 'retry-wait', error);
      } else {
        cycle.paused = true;
        notify(cycle, 'paused', error);
      }
      report(error);
    });
  };

  const retire = (entry: Entry, cycle: Cycle): void => {
    entry.cycle = null;
    cancel(cycle);
    if (cycle.sent !== null && client?.isConnected() && cycle.sent === client.getGeneration()) {
      const barrier: Barrier = { generation: cycle.sent };
      entry.barrier = barrier;
      barrier.timer = setTimeout(() => {
        barrier.timer = undefined;
        if (entry.barrier !== barrier) return;
        barrier.error = new PushrError('timeout', 'unsubscribe', undefined, entry.channel);
        if (entry.cycle) notify(entry.cycle, 'unknown', barrier.error);
        report(barrier.error);
      }, timing.unsubscribeTimeoutMs);
      try { client.unsubscribe(entry.channel); } catch { /* Client reports send failures and invalidates the transport. */ }
    } else if (!entry.barrier) entries.delete(entry.channel);
  };

  const acquireChannel = (channel: string, data?: unknown): PushrSubscription => {
    if (typeof channel !== 'string' || !channel.trim()) throw new PushrError('configuration', 'subscribe');
    const snapshot = channelSnapshot(data);
    const instance = getClient();
    let entry = entries.get(channel);
    if (!entry) { entry = { channel, cycle: null }; entries.set(channel, entry); }
    if (entry.cycle && entry.cycle.key !== snapshot.key) throw new PushrError('conflict', 'subscribe', undefined, channel);
    const cycle: Cycle = entry.cycle ?? {
      owners: new Set(), key: snapshot.key, data: snapshot.data, snapshot: Object.freeze({ state: 'waiting-connection' }),
      paused: false, sent: null, retries: 0,
    };
    entry.cycle = cycle;
    const owner: Owner = { released: false, observers: new Set(), events: new Map() };
    cycle.owners.add(owner);
    const getSnapshot = (): PushrSubscriptionSnapshot => owner.released ? Object.freeze({ state: 'released' }) : cycle.snapshot;
    const release = (): void => {
      if (owner.released) return;
      owner.released = true;
      cycle.owners.delete(owner);
      if (cycle.owners.size === 0 && entry!.cycle === cycle) retire(entry!, cycle);
      for (const observer of [...owner.observers]) safeCall(observer, getSnapshot());
      owner.observers.clear();
      owner.events.clear();
    };
    const handle: PushrSubscription = {
      getSnapshot, release,
      observe: listener => {
        if (owner.released) { safeCall(listener, getSnapshot()); return () => {}; }
        owner.observers.add(listener);
        safeCall(listener, getSnapshot());
        return () => { owner.observers.delete(listener); };
      },
      onEvent: (event, listener) => {
        if (owner.released) return () => {};
        const set = owner.events.get(event) ?? new Set();
        set.add(listener);
        owner.events.set(event, set);
        return () => { set.delete(listener); if (!set.size) owner.events.delete(event); };
      },
      retry: () => {
        if (owner.released || cycle.sent !== null || entry!.barrier || cycle.abort) return getSnapshot();
        clearTimeout(cycle.timer);
        cycle.timer = undefined;
        cycle.paused = false;
        cycle.retries = 0;
        if (!instance.isConnected()) void instance.connect();
        startCycle(entry!);
        return getSnapshot();
      },
    };
    startCycle(entry);
    instance.start();
    return handle;
  };

  const disconnect = (): void => {
    const instance = client;
    client = null;
    for (const entry of [...entries.values()]) {
      clearTimeout(entry.barrier?.timer);
      if (!entry.cycle) continue;
      const cycle = entry.cycle;
      cancel(cycle);
      for (const owner of [...cycle.owners]) {
        owner.released = true;
        for (const observer of [...owner.observers]) safeCall(observer, Object.freeze({ state: 'released' }));
        owner.observers.clear();
        owner.events.clear();
      }
      cycle.owners.clear();
      entry.cycle = null;
    }
    entries.clear();
    instance?.disconnect();
  };

  return { getClient, acquireChannel, disconnect, ensureConnected: async () => {
    const instance = getClient();
    await instance.connect();
    return instance;
  } };
};

export const defaultPushrService = createPushrService();
export const getPushrClient = (): PushrClient => defaultPushrService.getClient();
export const ensurePushrConnected = (): Promise<PushrClient> => defaultPushrService.ensureConnected();
export const acquirePushrChannel = (channel: string, data?: unknown): PushrSubscription => defaultPushrService.acquireChannel(channel, data);
export const disconnectPushr = (): void => defaultPushrService.disconnect();
