import { PushrError } from './errors.js';
import type { PushrErrorPhase } from './errors.js';
import type { PushrTimingOptions } from './types.js';

export const defaults = {
  connectTimeoutMs: 15000,
  connectionTimeoutMs: 10000,
  authTimeoutMs: 10000,
  subscribeTimeoutMs: 10000,
  unsubscribeTimeoutMs: 10000,
  reconnectDelayMs: 2000,
  maxReconnectDelayMs: 30000,
  pingIntervalMs: 25000,
  pongTimeoutMs: 10000,
};

/** Keepalive intervals accept 0 to disable the corresponding check. */
const optionalTimers = new Set<keyof typeof defaults>(['pingIntervalMs', 'pongTimeoutMs']);

export const timingOptions = (options: PushrTimingOptions): typeof defaults => {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = options[key] ?? defaults[key];
    if (!Number.isFinite(value) || value < 0 || (value === 0 && !optionalTimers.has(key)) || value > 2147483647) {
      throw new PushrError('configuration', 'connection');
    }
    result[key] = value;
  }
  return result;
};

export const backoff = (attempt: number, timing: typeof defaults, random: () => number): number => {
  const base = Math.min(timing.maxReconnectDelayMs, timing.reconnectDelayMs * 2 ** Math.min(attempt, 30));
  return Math.min(timing.maxReconnectDelayMs, base * (0.8 + Math.max(0, Math.min(1, random())) * 0.4));
};

/** Bound our wait even when an adapter ignores cancellation; also abort cooperative HTTP work. */
export const bounded = <T>(
  task: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  signals: AbortSignal[],
  phase: PushrErrorPhase,
  channel?: string,
): Promise<T> => new Promise<T>((resolve, reject) => {
  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: unknown, value?: T): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signals.forEach(signal => signal.removeEventListener('abort', cancel));
    if (error !== undefined) {
      reject(error);
      controller.abort();
    } else {
      resolve(value as T);
    }
  };
  const cancel = (): void => finish(new PushrError('cancelled', phase, undefined, channel));
  if (signals.some(signal => signal.aborted)) {
    cancel();
    return;
  }
  signals.forEach(signal => signal.addEventListener('abort', cancel, { once: true }));
  timer = setTimeout(() => finish(new PushrError('timeout', phase, undefined, channel)), timeoutMs);
  Promise.resolve().then(() => {
    if (settled) return;
    return task(controller.signal);
  }).then(value => finish(undefined, value as T), error => finish(error));
});

/** Stable JSON snapshot; reject lossy/non-JSON values instead of silently altering channel identity. */
export const channelSnapshot = (value: unknown): { key: string; data: unknown } => {
  if (value === undefined) return { key: 'absent', data: undefined };
  const ancestors = new Set<object>();
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw new PushrError('configuration', 'subscribe');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = '[' + Array.from(item, canonical).join(',') + ']';
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new PushrError('configuration', 'subscribe');
      result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical((item as Record<string, unknown>)[key])).join(',') + '}';
    }
    ancestors.delete(item);
    return result;
  };
  const key = canonical(value);
  return { key, data: JSON.parse(key) };
};
