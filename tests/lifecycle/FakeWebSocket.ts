export class FakeWebSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closes = 0;
  sendFailure = false;

  constructor(readonly url: string) {}

  open(): void { this.readyState = 1; this.onopen?.({}); }
  message(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
  ready(id = 'socket-1'): void { this.open(); this.message({ type: 'connection', socket_id: id, timestamp: 1 }); }
  error(): void { this.onerror?.({}); }
  serverClose(): void { this.readyState = 3; this.onclose?.({}); }
  close(): void { this.closes++; this.readyState = 3; this.onclose?.({}); }
  send(data: string): void {
    if (this.readyState !== 1 || this.sendFailure) throw new Error('send failed');
    this.sent.push(JSON.parse(data));
  }
}
