import { vi } from 'vitest';
import { FakeWebSocket } from './FakeWebSocket.js';
import { createPushrService } from '../../src/service.js';
import type { PushrServiceOptions } from '../../src/service.js';

export const signature = { appId: 'test-app', timestamp: 1, signature: 'TOP-SECRET' };
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
export const socketFactory = () => {
  const sockets: FakeWebSocket[] = [];
  const factory = vi.fn((url: string): WebSocket => {
    const socket = new FakeWebSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { sockets, factory };
};
export const serviceFixture = (options: PushrServiceOptions = {}) => {
  const { sockets, factory } = socketFactory();
  const request = { get: vi.fn(async () => signature), post: vi.fn(async () => ({ auth: 'AUTH-SECRET' })) };
  const onError = vi.fn();
  const service = createPushrService({
    resolveConfig: () => ({ url: 'wss://example.test' }), request, onError,
    webSocketFactory: factory, random: () => 0.5, pingIntervalMs: 0, ...options,
  });
  return { service, sockets, request, onError, factory };
};
