# @phpsoftbox/pushr

Браузерный клиент для подключения к Pushr WebSocket серверу.

## Установка

```bash
yarn add @phpsoftbox/pushr
```

## Быстрый старт

Нужен backend эндпоинт, который выдаёт подпись для подключения.

```ts
import { PushrClient } from '@phpsoftbox/pushr';

const client = new PushrClient({
  url: 'wss://pushr.example.com',
  getConnectSignature: async () => {
    const res = await fetch('/broadcast/connect');
    return await res.json();
  },
  getChannelAuth: async (channel, socketId, channelData) => {
    const res = await fetch('/broadcast/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        socket_id: socketId,
        channel,
        channel_data: channelData,
      }),
    });

    return await res.json();
  },
  autoReconnect: true,
});

await client.connect();

client.on('connection', (message) => {
  console.log('socket_id', message.socket_id);
});

await client.subscribe('news');
await client.subscribe('private-user.10');

client.onEvent('news', 'message', (data) => {
  console.log(data);
});
```

## Подключение и подпись

`getConnectSignature` должен вернуть объект:

```ts
type PushrConnectSignature = {
  appId: string;
  timestamp: number;
  signature: string;
  url?: string;
};
```

`url` можно вернуть, если сервер зависит от окружения (dev/prod).

## Авторизация приватных каналов

Для каналов `private-*`/`presence-*` клиент вызывает `getChannelAuth`.
Ответ должен содержать `auth` и опционально `channelData`:

```ts
type PushrChannelAuth = {
  auth: string;
  channelData?: unknown;
};
```

## События

- `connection` — сервер прислал `socket_id`
- `event` — сообщение из канала
- `subscribed` / `unsubscribed`
- `error`
- `disconnect`
