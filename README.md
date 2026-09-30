# @phpsoftbox/pushr

Браузерный клиент Pushr: WebSocket, восстановление соединения, управляемые
подписки на каналы и React-хук. Сервер публикует события в именованные каналы;
компоненты страницы приобретают канал на время своей работы.

При временном сетевом сбое service сохраняет активные подписки и восстанавливает
их без перезагрузки страницы. Он не доставляет события, пропущенные во время
отключения: актуальное состояние нужно получать через HTTP или другой механизм
синхронизации приложения.

## Установка

```bash
yarn add @phpsoftbox/pushr
```

Пакет — нативный ESM с TypeScript declarations. Основной entrypoint работает без
React; для `@phpsoftbox/pushr/react` приложение устанавливает React 18 или 19.
Переход между major-версиями: [с 2.x на 3.0](#миграция-с-2x-на-30),
[с 1.0.1](#миграция-с-api-101).

## Быстрый старт: service и владение каналом

Создайте один service для одной конфигурации подключения и переиспользуйте его
между компонентами. Независимые экземпляры service имеют независимые соединения.

```ts
import { createPushrService } from '@phpsoftbox/pushr';

export const pushr = createPushrService({
  resolveConfig: () => ({
    url: 'wss://pushr.example.com',
    connect: '/broadcast/connect',
    auth: '/broadcast/auth',
  }),
  onError: error => console.warn(error.kind, error.phase, error.status),
});

// Синхронно регистрирует потребителя, даже если сеть сейчас недоступна.
const subscription = pushr.acquireChannel('private.orders.42');
const stopEvents = subscription.onEvent('order.updated', payload => {
  console.log(payload);
});
const stopObserving = subscription.observe(snapshot => {
  console.log(snapshot.state);
  if (snapshot.error) console.warn(snapshot.error.kind, snapshot.error.phase);
});

// При завершении работы потребителя:
stopEvents();
stopObserving();
subscription.release();
```

`release()` идемпотентен и также удаляет listeners/observers этого handle.
Второй потребитель того же канала получает собственный handle. Освобождение
одного handle не отключает остальных; сетевые попытки не меняют число владельцев.
`observe()` сразу сообщает текущее состояние, затем его изменения. Возвращённая
функция удаляет observer. `getSnapshot()` позволяет прочитать состояние без
подписки на изменения. На освобождённом handle остаётся только состояние `released`.

По умолчанию настройки читаются из `window.__APP_CONFIG__.app.pushr` или
`window.__APP_CONFIG__.pushr`; `resolveConfig` переопределяет их. Если URL не задан,
используется текущий origin с протоколом ws/wss. HTTP endpoint по умолчанию:
`/broadcast/connect` и `/broadcast/auth`. Конфигурация фиксируется при создании
клиента и перечитывается после `service.disconnect()` при создании следующего.

Экспортирован `defaultPushrService` и helpers над ним: `getPushrClient`,
`ensurePushrConnected`, `acquirePushrChannel`, `disconnectPushr`.
React-хук по умолчанию использует этот же service.

## Состояния подписки и retry

| Состояние | Значение |
| --- | --- |
| `waiting-connection` | Намерение сохранено, протокол ещё не готов |
| `authorizing` | Запрашивается auth для текущего socket_id |
| `waiting-subscribed` | subscribe отправлен, ожидается подтверждение сервера |
| `subscribed` | Подписка подтверждена; handle доставляет события |
| `retry-wait` | Ожидание повторного auth после временной ошибки |
| `paused` | Auth требует вмешательства; автоматические попытки остановлены |
| `waiting-unsubscribed` | Новый цикл ждёт завершения предыдущего на этом сокете |
| `unknown` | Подтверждение не пришло вовремя; результат операции неизвестен |
| `released` | Потребитель освобождён |

Сетевая ошибка, timeout, HTTP 408/429/5xx при auth повторяются с backoff отдельно
для канала. HTTP 401/403, остальные 4xx и некорректный auth payload переводят
канал в `paused`. Reconnect не снимает эту приостановку. После обновления прав:

```ts
subscription.retry();
```

`retry()` возвращает текущий snapshot синхронно; за последующими изменениями
следит `observe()`. Вызов не увеличивает refcount. При отсутствии соединения это
явное подключение, при выполняющемся auth новая попытка не создаётся. При
неизвестном результате subscribe/unsubscribe метод возвращает текущее состояние
и не повторяет команду вслепую.

Транспортные ошибки доступны через `client.on('error', ...)`, service `onError`
и snapshots активных handles. Ошибки каналов доступны в их snapshots и общем
service `onError`. При использовании нескольких механизмов наблюдения не
записывайте одну ошибку в лог повторно без необходимости.

## Данные private/presence-каналов

Для `private.*` и `presence.*` выполняется auth с актуальным socket_id.
Public-каналы не требуют отдельного auth. Presence сейчас не означает наличие
автоматических событий join/leave: сервер их не отправляет.

```ts
const subscription = pushr.acquireChannel('presence.room.7', { user_id: 42 });
```

Данные — JSON-значение. Порядок ключей объектов не влияет на эквивалентность,
порядок элементов массива влияет. `undefined` означает отсутствие данных и
отличается от `null`. Циклические объекты, Date, BigInt, функции, undefined внутри
JSON и нечисловые значения NaN/Infinity не принимаются. Service сохраняет копию,
поэтому изменение исходного объекта не меняет действующую подписку.

Попытка приобрести занятый канал с другими данными синхронно выбрасывает
`PushrError` с `kind: 'conflict'`, не меняя владельцев и первую подписку.
Для смены данных освободите все handles канала и приобретите его заново.

## React

```ts
import { usePushrEvent } from '@phpsoftbox/pushr/react';
import { pushr } from './pushr.js';

usePushrEvent({
  service: pushr,
  channel: 'private.orders.42', // null отключает подписку
  event: 'order.updated',
  onMessage: payload => console.log(payload),
  onError: error => console.warn(error.kind, error.phase),
});
```

Хук владеет одним handle, регистрирует listener и освобождает ресурсы при cleanup.
Он не запускает собственные сетевые повторы. Listener остаётся активным после
длительного offline. Изменение callbacks или структурно эквивалентных channelData
не пересоздаёт подписку. Поддерживаются mount/unmount и повтор эффектов StrictMode.
Для пользовательского управления `retry()` используйте service handle напрямую.

## Транспорт и тайм-ауты

`PushrClient.connect()` и `service.ensureConnected()` завершают Promise после
получения `connection/socket_id`. Событие WebSocket open само по себе не означает
готовность протокола. Параллельные вызовы используют одну попытку, включая подпись.
В готовом состоянии они не создают новый сокет. Явный connect отменяет таймер
backoff и начинает попытку немедленно либо присоединяется к уже выполняющейся.

| Настройка | По умолчанию | Область |
| --- | --- | --- |
| `connectTimeoutMs` | 15000 | Подпись и открытие WebSocket вместе |
| `connectionTimeoutMs` | 10000 | От open до connection/socket_id |
| `authTimeoutMs` | 10000 | Один HTTP auth |
| `subscribeTimeoutMs` | 10000 | От subscribe до subscribed |
| `unsubscribeTimeoutMs` | 10000 | От unsubscribe до unsubscribed |
| `reconnectDelayMs` | 2000 | Начальная задержка транспортного и auth backoff |
| `maxReconnectDelayMs` | 30000 | Максимальная задержка после jitter |
| `pingIntervalMs` | 25000 | Период прикладного ping, `0` отключает keepalive |
| `pongTimeoutMs` | 10000 | Ожидание ответа на ping, `0` отключает обнаружение потери |

Все значения конечные и не превышают максимальный интервал JavaScript timer.
`pingIntervalMs` и `pongTimeoutMs` допускают `0`, остальные строго положительные;
некорректное значение выбрасывает `PushrError` с `kind: 'configuration'`. Передавайте их в `createPushrService` или `PushrClientOptions`.
Подписочные подтверждения обрабатывает service; прямой клиент их не ожидает.

Backoff удваивается, jitter составляет ±20%, итог ограничивается максимумом.
Транспортный backoff сбрасывается после socket_id, auth backoff — после успешного
auth. Service включает `autoReconnect` по умолчанию; прямой PushrClient требует
`autoReconnect: true`. `autoReconnect: false` отключает фоновые переподключения
транспорта, но не повторы auth уже желаемого канала на живом соединении.

Для тестов предусмотрены `random: () => number` (значение 0..1) и
`webSocketFactory: (url) => WebSocket`. Production по умолчанию использует
`Math.random` и браузерный WebSocket.

`client.disconnect()` отменяет ожидания и reconnect; поздние callbacks не создают
сокет. До явного `connect()` клиент остаётся остановленным. `service.disconnect()`
дополнительно освобождает все handles и забывает клиент. Следующий явный вызов
service создаёт новый клиент; освобождённые handles не возрождаются. При нулевом
refcount service сохраняет общий сокет и его транспортную политику до disconnect.

## Keepalive

Браузерный WebSocket не даёт доступа к control-кадрам ping/pong, поэтому
полуоткрытое соединение (обрыв без FIN из-за NAT, прокси или смены сети) само
по себе не обнаруживается: сокет остаётся в `readyState === 1`, события не приходят.
Клиент проверяет соединение прикладным ping:

- после получения `connection/socket_id` клиент раз в `pingIntervalMs` (25 с)
  отправляет `{"type":"ping"}`;
- если за `pongTimeoutMs` (10 с) после ping не пришло ни `{"type":"pong"}`, ни
  любое другое сообщение, соединение считается потерянным. Клиент закрывает сокет
  и идёт тем же путём, что и при `close`: событие `disconnect`, ошибка
  `PushrError` с `kind: 'timeout'`, `phase: 'keepalive'` в `client.on('error')` и
  service `onError`, reconnect с backoff при `autoReconnect`, восстановление
  подписок service после нового `socket_id`;
- любое входящее сообщение снимает ожидание ответа, поэтому при потоке событий
  лишних разрывов нет;
- `pong` обрабатывается внутри клиента и не доходит до `on(...)`, `onEvent(...)`
  и обработчиков service/React;
- таймеры принадлежат текущему соединению: они останавливаются при разрыве,
  `client.disconnect()` и `service.disconnect()` и не накапливаются при
  переподключениях.

```ts
const pushr = createPushrService({
  pingIntervalMs: 15000, // прокси закрывает простой короче 25 с
  pongTimeoutMs: 5000,
});
```

`pingIntervalMs: 0` полностью отключает keepalive (поведение 2.x).
`pongTimeoutMs: 0` оставляет отправку ping (например, чтобы соединение не
считалось простаивающим промежуточными прокси), но не разрывает его без ответа.

Сервер должен отвечать `{"type":"pong"}` на `{"type":"ping"}`: это делает
`phpsoftbox/broadcaster` с поддержкой keepalive. Сервер, игнорирующий такое
сообщение, при включённом keepalive будет разрываться клиентом каждые
`pingIntervalMs + pongTimeoutMs` простоя; с ним используйте `pingIntervalMs: 0`.

## Повторное владение и подтверждения сервера

Последний release после отправленного subscribe посылает unsubscribe, даже если
подтверждение подписки ещё не пришло. Новый владелец сразу регистрируется, но его
subscribe ждёт `unsubscribed` предыдущего цикла. Поздние subscribed и события
старого цикла не подтверждают и не обслуживают нового владельца.

После timeout подтверждения сохраняется `unknown`. Повторных команд и таймеров
нет. Поздний subscribed принимается только для ещё активного исходного цикла;
поздний unsubscribed снимает барьер и запускает новый цикл при наличии владельцев.
Смена поколения очищает барьеры. Другие каналы при этом продолжают работать.

Существующий сервер отправляет WS-ошибку без имени канала. Она сообщается как
некоррелированная `protocol`-ошибка: нельзя достоверно приписать её одной из
параллельных подписок. Отправленная команда не считается подтверждением.

## HTTP-адаптеры и диагностика

Стандартный адаптер использует fetch с `credentials: 'same-origin'`, передаёт
AbortSignal и сохраняет HTTP status. Для собственного request-адаптера:

```ts
import { PushrHttpError } from '@phpsoftbox/pushr';
import type { PushrServiceRequest } from '@phpsoftbox/pushr';

const request: PushrServiceRequest = {
  async get(url, signal) {
    const response = await fetch(url, { signal, credentials: 'same-origin' });
    if (!response.ok) throw new PushrHttpError(response.status);
    return response.json();
  },
  async post(url, body, signal) {
    const response = await fetch(url, {
      signal, method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new PushrHttpError(response.status);
    return response.json();
  },
};
```

Подпись подключения: `{ appId: string, timestamp: number, signature: string, url?: string }`.
Auth запрос содержит `{ socket_id, channel, channel_data }`; ответ —
`{ auth: string, channelData?: JSONValue }`.

`PushrError` содержит `kind`, `phase`, опциональные `status` и `channel`.
Стандартные диагностические сообщения не сохраняют исходные сообщения адаптера,
ответы HTTP, секреты или полный URL с подписью. Не определяйте тип ошибки по
`message`. Пользовательские ошибки HTTP нужно преобразовать в `PushrHttpError`;
обычный Error трактуется как сетевой сбой.

Отмена завершает внутренние ожидания сразу, с `kind: 'cancelled'`, без сообщения
потребителю о сетевом сбое при обычном cleanup. Адаптер, игнорирующий AbortSignal,
физически продолжит свой запрос; поздний результат не применяется. Браузер может
выводить собственные ошибки недоступного WebSocket независимо от диагностики пакета.

## Прямое использование PushrClient

Для низкоуровневой интеграции доступны `connect`, `disconnect`, `isConnected`,
`getSocketId`, `getGeneration`, `subscribe`, `unsubscribe`, `on/off`
и `onEvent/offEvent`. `getConnectSignature(signal)` и
`getChannelAuth(channel, socketId, channelData, signal)` принимают сигнал отмены.

`subscribe()` выполняет auth при необходимости и отправляет команду; его Promise
означает отправку, а не получение subscribed. Клиент не хранит желаемые каналы,
не восстанавливает их автоматически. Он публикует
события `connection`, `disconnect`, `error`, `subscribed`, `unsubscribed`, `event`.
Для разделения auth и отправки доступны `authorizeChannel` и `sendSubscribe`;
service использует их для собственных ограниченных попыток.

Не смешивайте низкоуровневые команды каналов с владением теми же каналами через
service: подтверждения протокола не содержат ID операции. `start()` запускает
транспорт при отсутствии попытки/backoff, но не отменяет явную остановку;
обычному приложению достаточно service.

Публикация событий из браузера не поддерживается: сервер разрешает `publish`
только соединению-публикатору бэкенда. Отправляйте события через backend
(`phpsoftbox/broadcaster`).

## Миграция с 2.x на 3.0

1. Удалён `PushrClient.publish()` и фаза ошибки `'publish'`. Сервер
   `phpsoftbox/broadcaster` 1.0 разрешает публикацию только соединению-публикатору
   бэкенда, поэтому из браузера команда всегда получала отказ. Перенесите
   публикацию на backend. Если код сравнивает `PushrError.phase` с `'publish'`,
   удалите эту ветку; добавлена фаза `'keepalive'`.
2. Включён прикладной keepalive: новые опции `pingIntervalMs` (25000) и
   `pongTimeoutMs` (10000) у `createPushrService` и `PushrClientOptions`,
   `0` отключает. Добавлен тип входящего сообщения `{ type: 'pong' }`
   в `PushrServerMessage`.
3. Требование к серверу: `phpsoftbox/broadcaster` с keepalive, отвечающий
   `{"type":"pong"}` на `{"type":"ping"}`. Обновляйте сервер до клиента или
   одновременно. Со старым сервером без такого ответа клиент при
   `pingIntervalMs > 0` будет переподключаться примерно каждые 35 с простоя;
   до обновления сервера передайте `pingIntervalMs: 0`.
4. Тесты приложения с fake timers и управляемым WebSocket после готовности
   соединения увидят таймер keepalive и исходящие `{"type":"ping"}`. Передайте
   в них `pingIntervalMs: 0` либо учитывайте эти сообщения.

## Миграция с API 1.0.1

Это несовместимое изменение JavaScript API, которое выпускается новой major-версией.
Номер версии и публикация выполняются отдельным release-процессом.

1. Замените `service.subscribe/unsubscribe` и helpers `subscribePushrChannel` /
   `unsubscribePushrChannel` на `acquireChannel/release` или `acquirePushrChannel`.
   Старые методы удалены. Сохраняйте handle каждого потребителя и освобождайте его.
2. Удалите собственные циклы retry в hooks. Используйте пакетный `usePushrEvent`
   либо регистрируйте события/observers через handle. Не удаляйте listener после
   временной ошибки сети и не приобретайте канал повторно при retry.
3. Передавайте AbortSignal в HTTP-адаптере, сохраняйте HTTP status через
   `PushrHttpError`. Для классификации используйте `PushrError.kind/phase/status`.
4. Учтите, что connect теперь ждёт socket_id. Клиентская подпись и auth могут быть
   отменены, поэтому их поздние ответы нельзя применять к новому соединению.
5. При повторном использовании канала согласуйте channelData. Для намеренной
   смены данных требуется завершить предыдущее владение.
6. Проверьте импорт удалённых helpers, открытие страницы offline, восстановление,
   навигацию, несколько компонентов одного канала и StrictMode. Обновляйте пакет
   вместе с потребителями, затем выполняйте frontend typecheck и production build.

## Разработка и проверки

```bash
yarn typecheck       # TypeScript исходников и lifecycle-тестов
yarn test:lifecycle  # fake timers, управляемый WebSocket/HTTP, настоящий React mount/unmount
yarn test:package    # build, npm pack, установка архива, native import и consumer-тесты
yarn test            # оба набора тестов
```

Проверка пакета не публикует npm-релиз. Порядок ответов сервера, необходимый для
барьера unsubscribed, дополнительно закреплён в тесте компонента Broadcaster.
