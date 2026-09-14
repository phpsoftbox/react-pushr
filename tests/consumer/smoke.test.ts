import { describe, expect, it, vi } from 'vitest';
import { PushrClient, createPushrService } from '@phpsoftbox/pushr';
import { usePushrEvent } from '@phpsoftbox/pushr/react';

describe('published Pushr package', () => {
  it('loads both exported entrypoints through the consumer resolver', () => {
    expect(PushrClient).toBeTypeOf('function');
    expect(createPushrService).toBeTypeOf('function');
    expect(usePushrEvent).toBeTypeOf('function');
  });

  /** Проверяет владение и подтверждения через установленный npm-архив. @see createPushrService */
  it('acquires and releases a channel using the installed package', async () => {
    const socket = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: vi.fn(), close: vi.fn(),
    } as unknown as WebSocket;
    const service = createPushrService({
      resolveConfig: () => ({ url: 'wss://example.test' }),
      request: {
        get: async () => ({ appId: 'app', timestamp: 1, signature: 'test' }),
        post: async () => ({ auth: 'test' }),
      },
      webSocketFactory: () => socket,
    });
    try {
      const subscription = service.acquireChannel('news');
      const listener = vi.fn(); subscription.onEvent('update', listener);
      const ready = service.ensureConnected();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      socket.onopen?.(new Event('open'));
      socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'connection', socket_id: 'one', timestamp: 1 }) }));
      await ready;
      socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'subscribed', channel: 'news' }) }));
      socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', channel: 'news', event: 'update', data: 42 }) }));
      expect(listener).toHaveBeenCalledExactlyOnceWith(42);
      expect(subscription.getSnapshot().state).toBe('subscribed');
      subscription.release();
      expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'unsubscribe', channel: 'news' }));
    } finally { service.disconnect(); }
  });
});
