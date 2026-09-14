import { useEffect, useRef } from 'react';
import { defaultPushrService } from './service.js';
import type { PushrService } from './service.js';
import { channelSnapshot } from './lifecycle.js';
import type { PushrError } from './errors.js';

export type UsePushrEventOptions = {
  channel: string | null;
  event: string;
  channelData?: unknown;
  onMessage: (payload: unknown) => void;
  onError?: (error: PushrError) => void;
  service?: PushrService;
};

export const usePushrEvent = ({ channel, event, channelData, onMessage, onError, service = defaultPushrService }: UsePushrEventOptions): void => {
  const callbacks = useRef({ onMessage, onError });
  useEffect(() => { callbacks.current = { onMessage, onError }; }, [onMessage, onError]);
  const dataKey = channelSnapshot(channelData).key;
  useEffect(() => {
    if (!channel) return;
    const subscription = service.acquireChannel(channel, channelData);
    let lastError: PushrError | undefined;
    const stopEvents = subscription.onEvent(event, payload => callbacks.current.onMessage(payload));
    const stopObserving = subscription.observe(snapshot => {
      if (snapshot.error && snapshot.error !== lastError) callbacks.current.onError?.(snapshot.error);
      lastError = snapshot.error;
    });
    return () => { stopEvents(); stopObserving(); subscription.release(); };
  }, [channel, event, dataKey, service]);
};
