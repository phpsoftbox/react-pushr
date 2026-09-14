// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushrEvent } from '../../src/react.js';
import type { UsePushrEventOptions } from '../../src/react.js';
import { deferred, flush, serviceFixture, signature } from './helpers.js';

const Consumer = (props: UsePushrEventOptions) => { usePushrEvent(props); return null; };

describe('React subscription lifecycle', () => {
  const roots: Root[] = [];
  const fixtures: ReturnType<typeof serviceFixture>[] = [];
  const create = () => { const fixture = serviceFixture(); fixtures.push(fixture); return fixture; };
  const render = async (props: UsePushrEventOptions, strict = false) => {
    const element = document.createElement('div'); document.body.appendChild(element);
    const root = createRoot(element); roots.push(root);
    await act(async () => { root.render(strict ? createElement(StrictMode, null, createElement(Consumer, props)) : createElement(Consumer, props)); });
    return root;
  };
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
  afterEach(async () => {
    await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
    fixtures.splice(0).forEach(fixture => fixture.service.disconnect());
    document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  /** Проверяет восстановление событий активного хука после длительного offline без remount. @see usePushrEvent */
  it('retains listeners across long initial offline and reconnect', async () => {
    const { service, request, sockets } = create(); request.get.mockRejectedValue(new Error('offline'));
    const onMessage = vi.fn(); const onError = vi.fn();
    await render({ service, channel: 'news', event: 'update', onMessage, onError });
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    expect(onError).toHaveBeenCalledTimes(7);
    request.get.mockResolvedValue(signature);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000); sockets[0].ready(); await flush();
      sockets[0].message({ type: 'subscribed', channel: 'news' });
      sockets[0].message({ type: 'event', channel: 'news', event: 'update', data: 'recovered' });
    });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith('recovered');
    await act(async () => {
      sockets[0].serverClose(); await vi.advanceTimersByTimeAsync(2000); sockets[1].ready('new'); await flush();
      sockets[1].message({ type: 'subscribed', channel: 'news' });
      sockets[1].message({ type: 'event', channel: 'news', event: 'update', data: 'again' });
    });
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  /** Проверяет unmount одного из двух настоящих компонентов без отключения второго. @see usePushrEvent */
  it('keeps the second mounted consumer subscribed', async () => {
    const { service, sockets } = create(); const first = vi.fn(); const second = vi.fn();
    const root = await render({ service, channel: 'news', event: 'update', onMessage: first });
    await render({ service, channel: 'news', event: 'update', onMessage: second });
    await act(async () => { sockets[0].ready(); await flush(); sockets[0].message({ type: 'subscribed', channel: 'news' }); });
    await act(async () => { root.render(null); });
    sockets[0].message({ type: 'event', channel: 'news', event: 'update' });
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
    expect(sockets[0].sent).toHaveLength(1);
  });

  /** Проверяет replay эффектов StrictMode на готовом сокете с барьером отписки. @see usePushrEvent */
  it('uses the unsubscribe barrier during StrictMode effect replay', async () => {
    const { service, sockets } = create(); const connecting = service.ensureConnected(); await flush(); sockets[0].ready(); await connecting;
    const onMessage = vi.fn();
    await render({ service, channel: 'news', event: 'update', onMessage }, true);
    expect(sockets[0].sent.map(item => item.type)).toEqual(['subscribe', 'unsubscribe']);
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    sockets[0].message({ type: 'event', channel: 'news', event: 'update' });
    expect(onMessage).not.toHaveBeenCalled();
    await act(async () => { sockets[0].message({ type: 'unsubscribed', channel: 'news' }); await flush(); });
    expect(sockets[0].sent.map(item => item.type)).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
    sockets[0].message({ type: 'subscribed', channel: 'news' });
    sockets[0].message({ type: 'event', channel: 'news', event: 'update' });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  /** Проверяет обновление callbacks и эквивалентных channelData без нового владения. @see usePushrEvent */
  it('updates callbacks without restarting an equivalent subscription', async () => {
    const { service, sockets, request } = create(); const first = vi.fn(); const second = vi.fn();
    const root = await render({ service, channel: 'private.one', event: 'update', channelData: { a: 1, b: 2 }, onMessage: first });
    await act(async () => { sockets[0].ready(); await flush(); sockets[0].message({ type: 'subscribed', channel: 'private.one' }); });
    await act(async () => { root.render(createElement(Consumer, { service, channel: 'private.one', event: 'update', channelData: { b: 2, a: 1 }, onMessage: second })); });
    sockets[0].message({ type: 'event', channel: 'private.one', event: 'update', data: 1 });
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledExactlyOnceWith(1);
    expect(request.post).toHaveBeenCalledTimes(1); expect(sockets[0].sent).toHaveLength(1);
  });

  /** Проверяет unmount во время auth и отсутствие поздней подписки/ошибки у закрытого компонента. @see usePushrEvent */
  it('cancels auth on unmount without resurrecting the component', async () => {
    const { service, sockets, request } = create(); const auth = deferred<{ auth: string }>(); request.post.mockReturnValueOnce(auth.promise);
    const onMessage = vi.fn(); const onError = vi.fn();
    const root = await render({ service, channel: 'private.one', event: 'update', onMessage, onError });
    await act(async () => { sockets[0].ready(); await flush(); });
    await act(async () => { root.render(null); });
    await act(async () => { auth.resolve({ auth: 'late' }); await flush(); });
    expect(sockets[0].sent).toEqual([]); expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Проверяет release нового компонента, ожидающего unsubscribed, без лишней подписки после подтверждения. @see usePushrEvent */
  it('does not subscribe after a waiting remount is itself unmounted', async () => {
    const { service, sockets } = create(); const onMessage = vi.fn();
    const root = await render({ service, channel: 'news', event: 'update', onMessage });
    await act(async () => { sockets[0].ready(); await flush(); });
    await act(async () => { root.render(null); });
    await act(async () => { root.render(createElement(Consumer, { service, channel: 'news', event: 'update', onMessage })); });
    await act(async () => { root.render(null); });
    await act(async () => { sockets[0].message({ type: 'unsubscribed', channel: 'news' }); await flush(); });
    expect(sockets[0].sent.map(item => item.type)).toEqual(['subscribe', 'unsubscribe']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
