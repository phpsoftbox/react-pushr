import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushrClient } from '../../src/client.js';
import { PushrHttpError } from '../../src/errors.js';
import { deferred, flush, signature, socketFactory } from './helpers.js';

describe('PushrClient lifecycle', () => {
  const clients: PushrClient[] = [];
  const create = (options: Partial<ConstructorParameters<typeof PushrClient>[0]> = {}) => {
    const { sockets, factory } = socketFactory();
    const sign = vi.fn(async () => signature);
    const client = new PushrClient({ url: 'wss://example.test', getConnectSignature: sign, webSocketFactory: factory, autoReconnect: true, random: () => 0.5, ...options });
    clients.push(client);
    return { client, sockets, sign };
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.useRealTimers(); });

  /** Проверяет общую попытку до подписи и готовность только после socket_id. @see PushrClient.connect */
  it('shares one attempt through signature, open and connection', async () => {
    const signing = deferred<typeof signature>();
    const { client, sockets, sign } = create({ getConnectSignature: () => signing.promise });
    const first = client.connect();
    expect(client.connect()).toBe(first);
    let ready = false;
    void first.then(() => { ready = true; });
    await flush();
    expect(sockets).toHaveLength(0);
    signing.resolve(signature);
    await flush();
    sockets[0].open();
    await flush();
    expect(ready).toBe(false);
    sockets[0].message({ type: 'connection', socket_id: 'current', timestamp: 1 });
    await first;
    expect(client.getSocketId()).toBe('current');
    await client.connect();
    expect(sockets).toHaveLength(1);
  });

  /** Проверяет устранение гонки явного подключения и таймера reconnect. @see PushrClient.connect */
  it('cancels a scheduled retry when explicitly connecting', async () => {
    const { client, sockets, sign } = create();
    const first = client.connect(); await flush(); sockets[0].ready(); await first;
    sockets[0].serverClose();
    const second = client.connect(); await flush(); sockets[1].ready('new'); await second;
    await vi.advanceTimersByTimeAsync(30000);
    expect(sockets).toHaveLength(2);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  /** Проверяет ограниченное ожидание подписи, handshake и connection. @see PushrClient.connect */
  it.each(['signature', 'open', 'connection'] as const)('bounds the %s stage', async phase => {
    const never = deferred<typeof signature>();
    const { client, sockets } = create(phase === 'signature' ? { getConnectSignature: () => never.promise } : {});
    const onError = vi.fn(); client.on('error', onError);
    const attempt = client.connect(); await flush();
    if (phase === 'connection') sockets[0].open();
    const rejection = expect(attempt).rejects.toMatchObject({ kind: 'timeout', phase });
    await vi.advanceTimersByTimeAsync(phase === 'connection' ? 10000 : 15000);
    await rejection;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  /** Проверяет завершение попытки при error и раннем close без зависшего Promise. @see PushrClient.connect */
  it.each(['error', 'serverClose'] as const)('settles an early %s and retries', async failure => {
    const { client, sockets } = create();
    const attempt = client.connect(); await flush();
    const rejection = expect(attempt).rejects.toMatchObject({ kind: 'network' });
    sockets[0][failure](); await rejection;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(2);
  });

  /** Проверяет немедленную отмену, AbortSignal и игнорирование поздней подписи. @see PushrClient.disconnect */
  it('disconnects during signing without creating a late socket', async () => {
    const signing = deferred<typeof signature>();
    let signal!: AbortSignal;
    const { client, sockets } = create({ getConnectSignature: abort => { signal = abort; return signing.promise; } });
    const attempt = client.connect(); await flush();
    client.disconnect();
    await expect(attempt).rejects.toMatchObject({ kind: 'cancelled' });
    expect(signal.aborted).toBe(true);
    signing.resolve(signature); await flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Проверяет остановку в connecting, connected и retry-wait с последующим явным connect. @see PushrClient.disconnect */
  it.each(['connecting', 'connected', 'retry-wait'])('disconnect stops %s', async state => {
    const { client, sockets } = create();
    const attempt = client.connect(); await flush();
    if (state !== 'connecting') { sockets[0].ready(); await attempt; }
    if (state === 'retry-wait') sockets[0].serverClose();
    client.disconnect();
    if (state === 'connecting') await expect(attempt).rejects.toMatchObject({ kind: 'cancelled' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const next = client.connect(); await flush(); sockets[1].ready('second'); await next;
    expect(client.getSocketId()).toBe('second');
  });

  /** Проверяет, что отложенные callbacks старого сокета не меняют новое поколение. @see PushrClient.connect */
  it('ignores every stale socket callback', async () => {
    const { client, sockets } = create();
    const first = client.connect(); await flush(); sockets[0].ready(); await first;
    const stale = { message: sockets[0].onmessage!, close: sockets[0].onclose!, error: sockets[0].onerror!, open: sockets[0].onopen! };
    sockets[0].serverClose();
    const second = client.connect(); await flush(); sockets[1].ready('new'); await second;
    stale.message({ data: JSON.stringify({ type: 'connection', socket_id: 'old', timestamp: 1 }) });
    stale.close({}); stale.error({}); stale.open({});
    expect(client.getSocketId()).toBe('new');
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Проверяет отключение фонового reconnect. @see PushrClient.connect */
  it('honors autoReconnect false', async () => {
    const { client, sockets } = create({ autoReconnect: false });
    const attempt = client.connect(); await flush(); sockets[0].error();
    await expect(attempt).rejects.toMatchObject({ kind: 'network' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
  });

  /** Проверяет верхнюю границу backoff после jitter и сброс после готовности. @see PushrClient.connect */
  it('caps jittered retries and resets backoff on connection', async () => {
    const sign = vi.fn().mockRejectedValue(new PushrHttpError(503));
    const { client, sockets } = create({ getConnectSignature: sign, random: () => 1 });
    client.start(); await flush();
    for (const delay of [2400, 4800, 9600, 19200, 30000, 30000]) {
      const before = sign.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sign).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(sign).toHaveBeenCalledTimes(before + 1);
    }
    sign.mockResolvedValue(signature);
    await vi.advanceTimersByTimeAsync(30000);
    sockets[0].ready(); sockets[0].serverClose();
    await vi.advanceTimersByTimeAsync(2400);
    expect(sockets).toHaveLength(2);
  });

  /** Проверяет очистку диагностик от текста адаптера и URL с подписью. @see PushrClient.connect */
  it('does not leak secrets from adapter or protocol errors', async () => {
    const { client, sockets } = create({ getConnectSignature: () => { throw new Error('https://host/?signature=SECRET'); } });
    const errors: unknown[] = []; client.on('error', error => errors.push(error));
    await expect(client.connect()).rejects.toMatchObject({ kind: 'network', phase: 'signature' });
    expect(JSON.stringify(errors)).not.toContain('SECRET');
  });

  /** Проверяет, что прямой клиент восстанавливает только транспорт, не каналы. @see PushrClient.subscribe */
  it('does not resubscribe low-level commands or replay publications', async () => {
    const { client, sockets } = create();
    const attempt = client.connect(); await flush(); sockets[0].ready(); await attempt;
    await client.subscribe('news'); await client.publish('news', 'update');
    sockets[0].serverClose(); await vi.advanceTimersByTimeAsync(2000); sockets[1].ready('new'); await flush();
    expect(sockets[1].sent).toEqual([]);
  });
});
