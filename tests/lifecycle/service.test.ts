import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushrService } from '../../src/service.js';
import { PushrHttpError } from '../../src/errors.js';
import { deferred, flush, serviceFixture, signature } from './helpers.js';

describe('Pushr service ownership', () => {
  const fixtures: ReturnType<typeof serviceFixture>[] = [];
  const create = (options: Parameters<typeof serviceFixture>[0] = {}) => {
    const fixture = serviceFixture(options); fixtures.push(fixture); return fixture;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { fixtures.splice(0).forEach(f => f.service.disconnect()); vi.useRealTimers(); });

  /** Проверяет refcount двух владельцев и одну команду на канал. @see createPushrService */
  it('shares subscription, delivers to each owner and releases independently', async () => {
    const { service, sockets } = create();
    const a = service.acquireChannel('news'); const b = service.acquireChannel('news');
    const one = vi.fn(); const two = vi.fn(); a.onEvent('update', one); b.onEvent('update', two);
    const connected = service.ensureConnected(); await flush(); sockets[0].ready(); await connected; await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toEqual([{ type: 'subscribe', channel: 'news' }]);
    expect(a.getSnapshot().state).toBe('waiting-subscribed');
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    sockets[0].message({ type: 'event', channel: 'news', event: 'update', data: 1 });
    expect(one).toHaveBeenCalledTimes(1); expect(two).toHaveBeenCalledTimes(1);
    a.release(); a.release();
    sockets[0].message({ type: 'event', channel: 'news', event: 'update', data: 2 });
    expect(one).toHaveBeenCalledTimes(1); expect(two).toHaveBeenCalledTimes(2);
    expect(sockets[0].sent).toHaveLength(1);
    b.release(); expect(sockets[0].sent[1]).toEqual({ type: 'unsubscribe', channel: 'news' });
    sockets[0].message({ type: 'unsubscribed', channel: 'news' });
    expect(vi.getTimerCount()).toBe(0);
    expect(sockets[0].closes).toBe(0);
  });

  /** Проверяет сохранение желания подписки при долгой недоступности сети. @see createPushrService */
  it('recovers an initially offline owner after many failed attempts', async () => {
    const { service, sockets, request, onError } = create();
    request.get.mockRejectedValue(new Error('offline'));
    const owner = service.acquireChannel('news'); const event = vi.fn(); owner.onEvent('update', event);
    await flush();
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) await vi.advanceTimersByTimeAsync(delay);
    expect(owner.getSnapshot().state).toBe('waiting-connection');
    expect(request.get).toHaveBeenCalledTimes(7);
    expect(onError).toHaveBeenCalledTimes(7);
    request.get.mockResolvedValue(signature);
    await vi.advanceTimersByTimeAsync(30000); sockets[0].ready(); await flush();
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    sockets[0].message({ type: 'event', channel: 'news', event: 'update' });
    expect(event).toHaveBeenCalledTimes(1);
  });

  /** Проверяет новый auth каждого private/presence канала после смены socket_id. @see createPushrService */
  it('reauthorizes once for each channel on the new connection', async () => {
    const { service, sockets, request } = create();
    service.acquireChannel('private.one'); service.acquireChannel('private.one'); service.acquireChannel('presence.two');
    await flush(); sockets[0].ready('old'); await flush();
    expect(request.post).toHaveBeenCalledTimes(2);
    sockets[0].serverClose();
    const next = service.ensureConnected(); await flush(); sockets[1].ready('new'); await next; await flush();
    expect(request.post).toHaveBeenCalledTimes(4);
    const bodies = request.post.mock.calls.map(call => (call as unknown[])[1]);
    expect(bodies.slice(2)).toEqual([
      { channel: 'private.one', socket_id: 'new', channel_data: undefined },
      { channel: 'presence.two', socket_id: 'new', channel_data: undefined },
    ]);
    expect(sockets[1].sent).toHaveLength(2);
  });

  /** Проверяет retry auth при живом WebSocket без нового connect. @see createPushrService */
  it.each([408, 429, 500, 503])('retries transient HTTP %s independently', async status => {
    const { service, sockets, request } = create();
    request.post.mockRejectedValueOnce(new PushrHttpError(status));
    const owner = service.acquireChannel('private.one'); service.acquireChannel('news');
    await flush(); sockets[0].ready(); await flush();
    expect(owner.getSnapshot()).toMatchObject({ state: 'retry-wait', error: { kind: 'http', status, channel: 'private.one' } });
    expect(sockets[0].sent).toEqual([{ type: 'subscribe', channel: 'news' }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(1); expect(request.post).toHaveBeenCalledTimes(2);
    expect(sockets[0].sent[1]).toMatchObject({ type: 'subscribe', channel: 'private.one' });
  });

  /** Проверяет сохранение отказа в правах через reconnect до явного retry. @see createPushrService */
  it.each([400, 401, 403, 404])('pauses HTTP %s until explicit retry', async status => {
    const { service, sockets, request } = create();
    request.post.mockRejectedValueOnce(new PushrHttpError(status));
    const owner = service.acquireChannel('private.one');
    await flush(); sockets[0].ready(); await flush();
    expect(owner.getSnapshot().state).toBe('paused');
    await vi.advanceTimersByTimeAsync(60000); expect(request.post).toHaveBeenCalledTimes(1);
    sockets[0].serverClose(); await vi.advanceTimersByTimeAsync(2000); sockets[1].ready('new'); await flush();
    expect(request.post).toHaveBeenCalledTimes(1);
    owner.retry(); await flush();
    expect(request.post).toHaveBeenCalledTimes(2);
    expect(sockets[1].sent).toHaveLength(1);
  });

  /** Проверяет некорректный auth payload как терминальную ошибку. @see createPushrService */
  it('pauses malformed auth responses', async () => {
    const { service, sockets, request } = create();
    request.post.mockResolvedValue({ auth: '' });
    const owner = service.acquireChannel('private.one'); await flush(); sockets[0].ready(); await flush();
    expect(owner.getSnapshot()).toMatchObject({ state: 'paused', error: { kind: 'protocol' } });
    expect(sockets[0].sent).toEqual([]);
  });

  /** Проверяет отмену auth последнего владельца и игнорирование позднего ответа. @see createPushrService */
  it('cancels auth without unsubscribing an unsent subscription', async () => {
    const auth = deferred<{ auth: string }>(); let signal!: AbortSignal;
    const fixture = create({ request: { get: async () => signature, post: async (_url, _body, abort) => { signal = abort; return auth.promise; } } });
    const { service, sockets } = fixture;
    const old = service.acquireChannel('private.one'); await flush(); sockets[0].ready(); await flush();
    old.release(); expect(signal.aborted).toBe(true);
    auth.resolve({ auth: 'stale' }); await flush();
    expect(sockets[0].sent).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  /** Проверяет отмену старого auth при reconnect без влияния на нового владельца. @see createPushrService */
  it('ignores old auth after a newer generation is ready', async () => {
    const old = deferred<{ auth: string }>();
    const { service, sockets, request } = create(); request.post.mockReturnValueOnce(old.promise);
    service.acquireChannel('private.one'); await flush(); sockets[0].ready(); await flush();
    sockets[0].serverClose(); await vi.advanceTimersByTimeAsync(2000); sockets[1].ready('new'); await flush();
    old.resolve({ auth: 'old-secret' }); await flush();
    expect(sockets[1].sent).toEqual([{ type: 'subscribe', channel: 'private.one', auth: 'AUTH-SECRET' }]);
  });

  /** Проверяет timeout auth даже для адаптера, игнорирующего AbortSignal. @see createPushrService */
  it('bounds a hung auth and retries without reconnecting', async () => {
    const auth = deferred<{ auth: string }>();
    const { service, sockets, request } = create(); request.post.mockReturnValueOnce(auth.promise);
    const owner = service.acquireChannel('private.one'); await flush(); sockets[0].ready(); await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(owner.getSnapshot()).toMatchObject({ state: 'retry-wait', error: { kind: 'timeout', phase: 'auth' } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(request.post).toHaveBeenCalledTimes(2); expect(sockets).toHaveLength(1);
    auth.resolve({ auth: 'stale' }); await flush(); expect(sockets[0].sent).toHaveLength(1);
  });

  /** Проверяет отсутствие слепого retry после timeout подтверждения и принятие позднего subscribed. @see createPushrService */
  it('keeps an uncertain subscription until late acknowledgement', async () => {
    const { service, sockets } = create();
    const owner = service.acquireChannel('news'); await flush(); sockets[0].ready(); await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(owner.retry()).toMatchObject({ state: 'unknown', error: { phase: 'subscribe' } });
    await vi.advanceTimersByTimeAsync(60000); expect(sockets[0].sent).toHaveLength(1);
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    expect(owner.getSnapshot().state).toBe('subscribed');
  });

  /** Проверяет барьер unsubscribed и отсутствие событий старого цикла у нового владельца. @see createPushrService */
  it('waits for unsubscribe acknowledgement before reacquiring on the same socket', async () => {
    const { service, sockets } = create();
    const old = service.acquireChannel('news'); await flush(); sockets[0].ready(); await flush();
    old.release(); const next = service.acquireChannel('news'); const listener = vi.fn(); next.onEvent('update', listener);
    expect(next.getSnapshot().state).toBe('waiting-unsubscribed');
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    sockets[0].message({ type: 'event', channel: 'news', event: 'update' });
    expect(listener).not.toHaveBeenCalled(); expect(sockets[0].sent).toHaveLength(2);
    sockets[0].message({ type: 'unsubscribed', channel: 'news' }); await flush();
    expect(sockets[0].sent.map(item => item.type)).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    sockets[0].message({ type: 'event', channel: 'news', event: 'update' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  /** Проверяет минимальную блокировку после timeout unsubscribed без повторных таймеров. @see createPushrService */
  it('keeps the barrier after timeout and accepts a late unsubscribed', async () => {
    const { service, sockets } = create();
    const first = service.acquireChannel('news'); await flush(); sockets[0].ready(); await flush();
    first.release(); const next = service.acquireChannel('news');
    await vi.advanceTimersByTimeAsync(10000);
    expect(next.retry()).toMatchObject({ state: 'unknown', error: { phase: 'unsubscribe' } });
    expect(vi.getTimerCount()).toBe(0);
    sockets[0].message({ type: 'unsubscribed', channel: 'news' }); await flush();
    expect(sockets[0].sent).toHaveLength(3);
  });

  /** Проверяет, что промежуточный владелец не порождает лишние unsubscribe и не оживает после release. @see createPushrService */
  it('does not resurrect a released waiter or accumulate unsubscribe commands', async () => {
    const { service, sockets } = create();
    const first = service.acquireChannel('news'); await flush(); sockets[0].ready(); await flush();
    first.release(); const next = service.acquireChannel('news'); next.release();
    const third = service.acquireChannel('news'); third.release();
    sockets[0].message({ type: 'unsubscribed', channel: 'news' }); await flush();
    expect(sockets[0].sent.map(item => item.type)).toEqual(['subscribe', 'unsubscribe']);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Проверяет снятие старого барьера при новом соединении и новый subscribe. @see createPushrService */
  it('clears unsubscribe barriers on a new generation', async () => {
    const { service, sockets } = create();
    const old = service.acquireChannel('news'); await flush(); sockets[0].ready(); await flush(); old.release();
    const next = service.acquireChannel('news');
    sockets[0].serverClose(); await vi.advanceTimersByTimeAsync(2000); sockets[1].ready('new'); await flush();
    expect(sockets[1].sent).toEqual([{ type: 'subscribe', channel: 'news' }]);
    expect(next.getSnapshot().state).toBe('waiting-subscribed');
  });

  /** Проверяет структурное сравнение данных и неизменность данных первой подписки. @see createPushrService */
  it('compares JSON structurally and snapshots channel data', async () => {
    const { service, sockets, request } = create();
    const data = { a: 1, b: { c: 2 } };
    const first = service.acquireChannel('private.one', data);
    const second = service.acquireChannel('private.one', { b: { c: 2 }, a: 1 });
    expect(() => service.acquireChannel('private.one', { a: 3 })).toThrow(expect.objectContaining({ kind: 'conflict' }));
    data.b.c = 99;
    await flush(); sockets[0].ready(); await flush();
    expect((request.post.mock.calls[0] as unknown[])[1]).toMatchObject({ channel_data: { a: 1, b: { c: 2 } } });
    first.release(); expect(sockets[0].sent).toHaveLength(1);
    second.release(); expect(sockets[0].sent).toHaveLength(2);
  });

  /** Проверяет отличие отсутствующих данных от JSON null. @see createPushrService */
  it('distinguishes absent channel data from null', () => {
    const { service } = create(); service.acquireChannel('news');
    expect(() => service.acquireChannel('news', null)).toThrow(expect.objectContaining({ kind: 'conflict' }));
  });

  /** Проверяет отсутствие произвольной корреляции серверной ошибки с каналом и утечки секретов. @see createPushrService */
  it('reports an uncorrelated server error without disrupting subscriptions', async () => {
    const { service, sockets, onError } = create();
    const owner = service.acquireChannel('news'); await flush(); sockets[0].ready(); await flush();
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    sockets[0].message({ type: 'error', message: 'Invalid signature SECRET https://host?signature=SECRET' });
    expect(onError.mock.calls[0][0]).toMatchObject({ kind: 'protocol', channel: undefined });
    expect(JSON.stringify(onError.mock.calls)).not.toContain('SECRET');
    expect(owner.getSnapshot().state).toBe('subscribed');
  });

  /** Проверяет отмену service во время подписи без возрождения клиента или старых владельцев. @see createPushrService */
  it('disconnect releases owners and cancels an in-flight connection', async () => {
    const pending = deferred<typeof signature>();
    const { service, sockets, request } = create(); request.get.mockReturnValueOnce(pending.promise);
    const owner = service.acquireChannel('news'); const observer = vi.fn(); owner.observe(observer);
    const attempt = service.ensureConnected(); await flush(); service.disconnect();
    await expect(attempt).rejects.toMatchObject({ kind: 'cancelled' });
    pending.resolve(signature); await flush(); await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(0); expect(owner.getSnapshot().state).toBe('released');
    const count = observer.mock.calls.length;
    owner.retry(); owner.release(); await flush(); expect(observer).toHaveBeenCalledTimes(count);
  });

  /** Проверяет отмену таймера auth, когда последний владелец освобождён. @see createPushrService */
  it('cancels auth backoff on final release', async () => {
    const { service, sockets, request } = create(); request.post.mockRejectedValue(new Error('offline'));
    const owner = service.acquireChannel('private.one'); await flush(); sockets[0].ready(); await flush();
    owner.release(); await vi.advanceTimersByTimeAsync(60000);
    expect(request.post).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  /** Проверяет передачу AbortSignal стандартному fetch и сохранение HTTP status. @see createPushrService */
  it('passes abort signals through the built-in HTTP adapter', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(signature)))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const { service, sockets } = create({ request: undefined });
      const owner = service.acquireChannel('private.one'); await flush(); sockets[0].ready(); await flush();
      expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(fetcher.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
      expect(owner.getSnapshot()).toMatchObject({ state: 'paused', error: { status: 403 } });
    } finally { vi.unstubAllGlobals(); }
  });
});
