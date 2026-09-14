export type PushrErrorKind = 'cancelled' | 'timeout' | 'network' | 'http' | 'protocol' | 'conflict' | 'configuration' | 'listener';
export type PushrErrorPhase = 'signature' | 'open' | 'connection' | 'auth' | 'subscribe' | 'unsubscribe' | 'publish' | 'listener';

/** Safe diagnostics: never retain URLs, signatures, HTTP bodies or adapter error messages. */
export class PushrError extends Error {
  constructor(
    public readonly kind: PushrErrorKind,
    public readonly phase: PushrErrorPhase,
    public readonly status?: number,
    public readonly channel?: string,
  ) {
    super(`Pushr ${phase}: ${kind}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'PushrError';
  }
}

/** Throw from custom HTTP adapters to preserve status without exposing response data. */
export class PushrHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Pushr HTTP request failed (${status})`);
    this.name = 'PushrHttpError';
  }
}

export const normalizeError = (error: unknown, phase: PushrErrorPhase, channel?: string): PushrError => {
  if (error instanceof PushrError) {
    return new PushrError(error.kind, phase, error.status, channel);
  }
  const status = error instanceof PushrHttpError ? error.status : undefined;
  return new PushrError(status === undefined ? 'network' : 'http', phase, status, channel);
};

export const isTransient = (error: PushrError): boolean => error.kind === 'network'
  || error.kind === 'timeout'
  || (error.kind === 'http' && (error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500 && error.status <= 599)));
