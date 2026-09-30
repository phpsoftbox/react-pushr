import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushrClient } from '../../src/client.js';
import { flush, serviceFixture, signature, socketFactory } from './helpers.js';

describe('Pushr keepalive', () => {
  const clients: PushrClient[] = [];
  const services: ReturnType<typeof serviceFixture>[] = [];
  const create = (options: Partial<ConstructorParameters<typeof PushrClient>[0]> = {}) => {
    const { sockets, factory } = socketFactory();
    const client = new PushrClient({
      url: 'wss://example.test', getConnectSignature: async () => signature, webSocketFactory: factory,
      autoReconnect: true, random: () => 0.5, pingIntervalMs: 25000, pongTimeoutMs: 10000, ...options,
    });
    clients.push(client);
    return { client, sockets };
  };
  const connected = async (options: Partial<ConstructorParameters<typeof PushrClient>[0]> = {}) => {
    const fixture = create(options);
    const attempt = fixture.client.connect(); await flush(); fixture.sockets[0].ready(); await attempt;
    return fixture;
  };
  const pings = (sent: Record<string, unknown>[]): number => sent.filter(item => item.type === 'ping').length;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clients.splice(0).forEach(client => client.disconnect());
    services.splice(0).forEach(fixture => fixture.service.disconnect());
    vi.useRealTimers();
  });

  /** Проверяет отправку прикладного ping раз в pingIntervalMs при получении pong. @see PushrClient.connect */
  it('sends ping every interval while the connection is ready', async () => {
    const { sockets } = await connected();
    // До истечения интервала ping не отправляется.
    await vi.advanceTimersByTimeAsync(24999);
    expect(sockets[0].sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0].sent).toEqual([{ type: 'ping' }]);
    sockets[0].message({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(25000);
    sockets[0].message({ type: 'pong' });
    expect(pings(sockets[0].sent)).toBe(2);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].closes).toBe(0);
  });

  /** Проверяет, что без pong соединение считается потерянным и переподключается. @see PushrClient.connect */
  it('reconnects when no message arrives within pongTimeoutMs', async () => {
    const { client, sockets } = await connected();
    const errors: unknown[] = []; client.on('error', error => errors.push(error));
    const disconnects: unknown[] = []; client.on('disconnect', payload => disconnects.push(payload));
    await vi.advanceTimersByTimeAsync(25000 + 9999);
    expect(sockets[0].closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    // Потеря соединения идёт тем же путём, что и close: отключение, ошибка и backoff.
    expect(sockets[0].closes).toBe(1);
    expect(client.isConnected()).toBe(false);
    expect(disconnects).toEqual([{ manual: false }]);
    expect(errors).toEqual([expect.objectContaining({ kind: 'timeout', phase: 'keepalive' })]);
    await vi.advanceTimersByTimeAsync(2000); await flush();
    expect(sockets).toHaveLength(2);
    sockets[1].ready('new'); await flush();
    expect(client.getSocketId()).toBe('new');
  });

  /** Проверяет, что любое входящее сообщение, а не только pong, снимает ожидание ответа. @see PushrClient.connect */
  it('treats any inbound message as a keepalive reply', async () => {
    const { client, sockets } = await connected();
    await vi.advanceTimersByTimeAsync(25000 + 9999);
    sockets[0].message({ type: 'event', channel: 'news', event: 'update', data: 1 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(sockets[0].closes).toBe(0);
    expect(client.isConnected()).toBe(true);
  });

  /** Проверяет, что после disconnect не остаётся таймеров keepalive и ping не отправляется. @see PushrClient.disconnect */
  it('stops pinging after disconnect', async () => {
    const { client, sockets } = await connected();
    expect(vi.getTimerCount()).toBe(1);
    client.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets[0].sent).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  /** Проверяет остановку keepalive при закрытии service (dispose). @see createPushrService */
  it('stops pinging after service disconnect', async () => {
    const fixture = serviceFixture({ pingIntervalMs: 25000 }); services.push(fixture);
    const { service, sockets } = fixture;
    const ready = service.ensureConnected(); await flush(); sockets[0].ready(); await ready;
    service.disconnect();
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets[0].sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Проверяет, что pingIntervalMs = 0 полностью отключает keepalive. @see PushrClient.connect */
  it('disables keepalive with pingIntervalMs 0', async () => {
    const { client, sockets } = await connected({ pingIntervalMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300000);
    expect(sockets[0].sent).toEqual([]);
    expect(client.isConnected()).toBe(true);
  });

  /** Проверяет, что pongTimeoutMs = 0 оставляет ping, но отключает обнаружение потери. @see PushrClient.connect */
  it('disables loss detection with pongTimeoutMs 0', async () => {
    const { client, sockets } = await connected({ pongTimeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(100000);
    expect(pings(sockets[0].sent)).toBe(4);
    expect(client.isConnected()).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  /** Проверяет, что pong не доходит до обработчиков событий и не считается ошибкой протокола. @see PushrClient.on */
  it('does not deliver pong to listeners', async () => {
    const { client, sockets } = await connected();
    const listener = vi.fn();
    for (const type of ['pong', 'event', 'error', 'subscribed', 'unsubscribed', 'connection']) client.on(type, listener);
    client.onEvent('news', 'pong', listener);
    await vi.advanceTimersByTimeAsync(25000);
    sockets[0].message({ type: 'pong' });
    expect(listener).not.toHaveBeenCalled();
  });

  /** Проверяет, что таймеры keepalive не дублируются после переподключения. @see PushrClient.connect */
  it('keeps a single keepalive schedule across reconnects', async () => {
    const { sockets } = await connected();
    sockets[0].serverClose();
    await vi.advanceTimersByTimeAsync(2000); await flush();
    sockets[1].ready('new'); await flush();
    await vi.advanceTimersByTimeAsync(25000);
    sockets[1].message({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(25000);
    // Один ping на интервал на новом сокете, старый сокет не используется.
    expect(pings(sockets[1].sent)).toBe(2);
    expect(sockets[0].sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(2);
  });

  /** Проверяет восстановление подписок service после потери соединения по keepalive. @see createPushrService */
  it('restores service subscriptions after a keepalive timeout', async () => {
    const fixture = serviceFixture({ pingIntervalMs: 25000, pongTimeoutMs: 10000 }); services.push(fixture);
    const { service, sockets, onError } = fixture;
    const owner = service.acquireChannel('news'); const event = vi.fn(); owner.onEvent('update', event);
    await flush(); sockets[0].ready(); await flush();
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    expect(owner.getSnapshot().state).toBe('subscribed');
    // Сервер перестал отвечать: ping ушёл, ответа нет.
    await vi.advanceTimersByTimeAsync(35000);
    expect(owner.getSnapshot().state).toBe('waiting-connection');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout', phase: 'keepalive' }));
    await vi.advanceTimersByTimeAsync(2000); await flush();
    sockets[1].ready('new'); await flush();
    expect(sockets[1].sent).toEqual([{ type: 'subscribe', channel: 'news' }]);
    sockets[1].message({ type: 'subscribed', channel: 'news' });
    sockets[1].message({ type: 'event', channel: 'news', event: 'update', data: 7 });
    expect(event).toHaveBeenCalledExactlyOnceWith(7);
  });

  /** Проверяет отказ для отрицательных и нечисловых интервалов keepalive. @see PushrClient */
  it.each([
    { pingIntervalMs: -1 },
    { pongTimeoutMs: Number.NaN },
  ])('rejects invalid keepalive option %o', options => {
    expect(() => create(options)).toThrow(expect.objectContaining({ kind: 'configuration' }));
  });
});
