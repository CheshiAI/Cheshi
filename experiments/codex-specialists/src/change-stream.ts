import { randomUUID, timingSafeEqual } from 'node:crypto';

/** Notifications invalidate host caches; the durable journals remain the source of truth. */
export class WorkerChangeStream {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly encoder = new TextEncoder();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private frame(kind: 'change' | 'ready' | 'heartbeat') {
    return this.encoder.encode(`${JSON.stringify({ protocol: 1, epoch: this.epoch, sequence: this.sequence, kind })}\n`);
  }
  changed() {
    this.sequence++;
    this.broadcast('change');
  }
  private broadcast(kind: 'change' | 'heartbeat') {
    const frame = this.frame(kind);
    for (const client of this.clients) {
      // A slow consumer reconnects and resynchronizes instead of buffering indefinitely.
      if ((client.desiredSize ?? 0) <= 0) { this.clients.delete(client); client.close(); }
      else client.enqueue(frame);
    }
    this.stopHeartbeatIfIdle();
  }
  handle(request: Request, token: string) {
    if (request.method !== 'POST' || request.headers.has('origin')) return new Response(null, { status: 403 });
    const actual = Buffer.from(request.headers.get('authorization') ?? ''), expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return new Response(null, { status: 401 });
    return this.response(request.signal);
  }
  response(signal: AbortSignal) {
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const close = () => { this.clients.delete(controller); signal.removeEventListener('abort', close); try { controller.close(); } catch {} this.stopHeartbeatIfIdle(); };
        cleanup = close;
        if (signal.aborted) { close(); return; }
        this.clients.add(controller);
        signal.addEventListener('abort', close, { once: true });
        controller.enqueue(this.frame('ready'));
        this.heartbeat ??= setInterval(() => this.broadcast('heartbeat'), 120_000);
      },
      cancel: () => cleanup(),
    }, { highWaterMark: 64 });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  }
  private stopHeartbeatIfIdle() { if (!this.clients.size) { clearInterval(this.heartbeat); this.heartbeat = undefined; } }
  dispose() { for (const client of this.clients) client.close(); this.clients.clear(); this.stopHeartbeatIfIdle(); }
}
