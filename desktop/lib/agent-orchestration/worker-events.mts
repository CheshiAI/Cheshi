import type { CollaborationConnection } from './service.mts';

export type WatchWorker = (connection: CollaborationConnection, changed: () => void, failed: (error: Error) => void) => () => void;

/** Authenticated loopback stream. Reconnect receipts always invalidate caches, including after worker restart. */
export const watchWorker: WatchWorker = (connection, changed, failed) => {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Worker events require a loopback endpoint.');
  }
  let stopped = false, attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined, health: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const connect = async () => {
    const abort = new AbortController(); controller = abort;
    const alive = () => { clearTimeout(health); health = setTimeout(() => abort.abort(), 150_000); health.unref(); };
    alive();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(new URL('/events', url), { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${connection.token}` }, signal: abort.signal });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Worker events unavailable. Update or restart the worker.'); }
      reader = response.body.getReader();
      let buffer = '', epoch = '', sequence = -1;
      const decoder = new TextDecoder();
      while (!stopped) {
        const part = await reader.read();
        if (part.done) throw new Error('Worker event connection closed.');
        alive(); buffer += decoder.decode(part.value, { stream: true });
        if (buffer.length > 65_536) throw new Error('Invalid worker event size.');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const event = JSON.parse(line);
          if (event?.protocol !== 1 || typeof event.epoch !== 'string' || event.epoch.length > 80 || !event.epoch
            || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || !['ready', 'change', 'heartbeat'].includes(event.kind)) throw new Error('Invalid worker event.');
          if (!epoch && event.kind !== 'ready') throw new Error('Missing worker event handshake.');
          if (event.kind === 'ready' || event.epoch !== epoch || event.sequence > sequence) {
            epoch = event.epoch; sequence = event.sequence; attempts = 0;
            changed(); // Read authoritative journals; this also repairs any sequence gap.
          }
        }
      }
    } catch (error) {
      if (!stopped) failed(error instanceof Error ? error : new Error('Worker event connection failed.'));
    } finally {
      clearTimeout(health); abort.abort(); await reader?.cancel().catch(() => {});
      if (!stopped) { retry = setTimeout(() => { void connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5))); retry.unref(); }
    }
  };
  void connect();
  return () => { stopped = true; clearTimeout(retry); clearTimeout(health); controller?.abort(); };
};
