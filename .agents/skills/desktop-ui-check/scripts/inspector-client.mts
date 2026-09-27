/** Minimal Inspector transport; no application launch or process mutation. */
export class InspectorClient {
  private socket: WebSocket;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.failPending(new Error('Inspector connection closed')));
    socket.addEventListener('error', () => this.failPending(new Error('Inspector connection failed')));
  }

  static async connect(url: string, timeoutMs = 3000) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw new Error('Inspector must use loopback WebSocket');
    const socket = new WebSocket(url);
    const client = new InspectorClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Inspector closed before connecting')); }, { once: true });
    });
    return client;
  }

  async evaluate<T>(expression: string, timeoutMs = 10000): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs) as {
      result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value as T;
  }

  send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Inspector is not connected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inspector request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private failPending(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  close() {
    this.failPending(new Error('Inspector client closed'));
    this.socket.close();
  }
}
