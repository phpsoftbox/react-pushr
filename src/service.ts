import { PushrClient } from './client';
import type { PushrChannelAuth, PushrConnectSignature } from './types';

type PushrConfig = {
  url?: string;
  connect?: string;
  auth?: string;
};

type AppConfig = {
  app?: {
    pushr?: PushrConfig;
  };
  pushr?: PushrConfig;
};

export type PushrServiceRequest = {
  get: (url: string) => Promise<unknown>;
  post: (url: string, body: unknown) => Promise<unknown>;
};

export type PushrServiceOptions = {
  resolveConfig?: () => Partial<PushrConfig>;
  request?: PushrServiceRequest;
  autoReconnect?: boolean;
};

export type PushrService = {
  getClient: () => PushrClient;
  ensureConnected: () => Promise<PushrClient>;
  subscribe: (channel: string, channelData?: unknown) => Promise<void>;
  unsubscribe: (channel: string) => void;
  disconnect: () => void;
};

const defaultResolveConfig = (): Partial<PushrConfig> => {
  if (typeof window === 'undefined') {
    return {};
  }

  const config = (window as { __APP_CONFIG__?: AppConfig }).__APP_CONFIG__;
  return config?.app?.pushr ?? config?.pushr ?? {};
};

const defaultRequest: PushrServiceRequest = {
  get: async (url: string) => {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!response.ok) {
      throw new Error(`Pushr request failed (${response.status})`);
    }

    return response.json();
  },
  post: async (url: string, body: unknown) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Pushr request failed (${response.status})`);
    }

    return response.json();
  },
};

const normalizePushrUrl = (url: string): string => {
  if (url.startsWith('https:')) {
    return url.replace(/^https:/i, 'wss:');
  }
  if (url.startsWith('http:')) {
    return url.replace(/^http:/i, 'ws:');
  }
  if (typeof window !== 'undefined' && url.startsWith('ws:') && window.location.protocol === 'https:') {
    return url.replace(/^ws:/i, 'wss:');
  }

  return url;
};

export const createPushrService = (options: PushrServiceOptions = {}): PushrService => {
  let client: PushrClient | null = null;
  let connectPromise: Promise<void> | null = null;
  const subscriptions = new Map<string, { count: number; channelData?: unknown }>();
  const request = options.request ?? defaultRequest;

  const resolveConfig = (): Required<PushrConfig> => {
    const base = defaultResolveConfig();
    const override = options.resolveConfig?.() ?? {};
    const config = { ...base, ...override };

    const defaultUrl =
      typeof window !== 'undefined' ? window.location.origin.replace(/^http/i, 'ws') : '';
    const resolvedUrl = config.url ?? defaultUrl;

    if (!resolvedUrl) {
      throw new Error('Pushr url is not configured.');
    }

    return {
      url: resolvedUrl,
      connect: config.connect ?? '/broadcast/connect',
      auth: config.auth ?? '/broadcast/auth',
    };
  };

  const getClient = (): PushrClient => {
    if (client) {
      return client;
    }

    const config = resolveConfig();
    const resolvedUrl = normalizePushrUrl(config.url);

    client = new PushrClient({
      url: resolvedUrl,
      getConnectSignature: async () =>
        (await request.get(config.connect)) as PushrConnectSignature,
      getChannelAuth: async (channelName, socketId, channelData) =>
        (await request.post(config.auth, {
          socket_id: socketId,
          channel: channelName,
          channel_data: channelData,
        })) as PushrChannelAuth,
      autoReconnect: options.autoReconnect ?? true,
    });

    client.on('connection', () => {
      subscriptions.forEach((entry, channelName) => {
        void client?.subscribe(channelName, entry.channelData).catch(() => undefined);
      });
    });

    return client;
  };

  const ensureConnected = async (): Promise<PushrClient> => {
    const instance = getClient();

    if (!connectPromise) {
      connectPromise = instance.connect().catch((error) => {
        connectPromise = null;
        throw error;
      });
    }

    await connectPromise;
    return instance;
  };

  const subscribe = async (channel: string, channelData?: unknown): Promise<void> => {
    const entry = subscriptions.get(channel);
    if (entry) {
      entry.count += 1;
      if (entry.channelData === undefined && channelData !== undefined) {
        entry.channelData = channelData;
      }
      return;
    }

    const instance = await ensureConnected();
    await instance.subscribe(channel, channelData);
    subscriptions.set(channel, { count: 1, channelData });
  };

  const unsubscribe = (channel: string): void => {
    const entry = subscriptions.get(channel);
    if (!entry) {
      return;
    }

    entry.count -= 1;
    if (entry.count > 0) {
      return;
    }

    subscriptions.delete(channel);
    if (client) {
      client.unsubscribe(channel);
    }
  };

  const disconnect = (): void => {
    if (!client) {
      return;
    }

    client.disconnect();
    client = null;
    connectPromise = null;
    subscriptions.clear();
  };

  return {
    getClient,
    ensureConnected,
    subscribe,
    unsubscribe,
    disconnect,
  };
};

const defaultService = createPushrService();

export const getPushrClient = (): PushrClient => defaultService.getClient();
export const ensurePushrConnected = (): Promise<PushrClient> => defaultService.ensureConnected();
export const subscribePushrChannel = (channel: string, channelData?: unknown): Promise<void> =>
  defaultService.subscribe(channel, channelData);
export const unsubscribePushrChannel = (channel: string): void => defaultService.unsubscribe(channel);
export const disconnectPushr = (): void => defaultService.disconnect();
