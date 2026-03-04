import { useEffect } from 'react';
import { createPushrService } from './service';
import type { PushrService } from './service';

export type UsePushrEventOptions = {
  channel: string | null;
  event: string;
  channelData?: unknown;
  onMessage: (payload: unknown) => void;
  onError?: (error: unknown) => void;
  service?: PushrService;
};

const defaultService = createPushrService();
const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 200;

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes('socket id is not available yet')
    || message.includes('websocket is not connected')
    || message.includes('websocket connection failed')
  );
};

export const usePushrEvent = ({
  channel,
  event,
  channelData,
  onMessage,
  onError,
  service = defaultService,
}: UsePushrEventOptions) => {
  useEffect(() => {
    if (!channel) {
      return undefined;
    }

    const client = service.getClient();
    let active = true;
    let retryTimer: number | null = null;

    const handler = (payload: unknown) => {
      if (!active) {
        return;
      }
      onMessage(payload);
    };

    const start = async (attempt: number = 0): Promise<void> => {
      try {
        await service.subscribe(channel, channelData);
        if (!active) {
          return;
        }

        client.onEvent(channel, event, handler);
      } catch (error) {
        if (!active) {
          return;
        }

        if (attempt < DEFAULT_RETRY_ATTEMPTS && isRetryableError(error)) {
          retryTimer = window.setTimeout(() => {
            void start(attempt + 1);
          }, DEFAULT_RETRY_DELAY_MS);

          return;
        }

        onError?.(error);
      }
    };

    void start();

    return () => {
      active = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }

      client.offEvent(channel, event, handler);
      try {
        service.unsubscribe(channel);
      } catch {
        // ignore cleanup errors for already closed sockets
      }
    };
  }, [channel, channelData, event, onMessage, onError, service]);
};
