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

    const handler = (payload: unknown) => {
      if (!active) {
        return;
      }
      onMessage(payload);
    };

    const start = async () => {
      try {
        await service.subscribe(channel, channelData);
        client.onEvent(channel, event, handler);
      } catch (error) {
        if (onError) {
          onError(error);
        }
      }
    };

    void start();

    return () => {
      active = false;
      client.offEvent(channel, event, handler);
      service.unsubscribe(channel);
    };
  }, [channel, channelData, event, onMessage, onError, service]);
};
