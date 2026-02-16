export type PushrConnectSignature = {
  appId: string;
  timestamp: number;
  signature: string;
  url?: string;
};

export type PushrChannelAuth = {
  auth: string;
  channelData?: unknown;
};

export type PushrEventMessage = {
  type: 'event';
  channel: string;
  event: string;
  data?: unknown;
};

export type PushrConnectionMessage = {
  type: 'connection';
  socket_id: string;
  timestamp: number;
};

export type PushrServerMessage =
  | PushrEventMessage
  | PushrConnectionMessage
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'error'; message: string };

export type PushrClientOptions = {
  url: string;
  getConnectSignature: () => Promise<PushrConnectSignature> | PushrConnectSignature;
  getChannelAuth?: (
    channel: string,
    socketId: string,
    channelData?: unknown
  ) => Promise<PushrChannelAuth> | PushrChannelAuth;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
};
