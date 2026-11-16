import { resolve, sep } from 'node:path';
import { VoiceRelay } from './relay.ts';
import { VOICE_FRAME_LIMIT, voiceServerUrl } from '../../shared/voice-protocol.ts';

export function startConnectionServer(options: { origin: string; port: number; hostname?: string; assets: string }) {
  const origin = voiceServerUrl(options.origin).origin, relay = new VoiceRelay();
  const assets = resolve(options.assets);
  const security = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'microphone=(self), camera=()', 'Cache-Control': 'no-store',
    ...(origin.startsWith('https:') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
  const server = Bun.serve<undefined>({
    port: options.port, hostname: options.hostname ?? '127.0.0.1', maxRequestBodySize: VOICE_FRAME_LIMIT,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get('host') !== new URL(origin).host) return new Response('Unknown host', { status: 403 });
      if (url.pathname === '/connect') {
        const requestOrigin = request.headers.get('origin');
        if (requestOrigin !== null && requestOrigin !== origin) return new Response('Invalid origin', { status: 403 });
        if (server.upgrade(request, { data: undefined })) return undefined;
        return new Response('WebSocket required', { status: 426 });
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const path = resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(assets + sep)) return new Response('Not found', { status: 404 });
      const file = Bun.file(path);
      if (!await file.exists()) return new Response('Not found', { status: 404, headers: security });
      return new Response(file, { headers: security });
    },
    websocket: {
      maxPayloadLength: VOICE_FRAME_LIMIT, idleTimeout: 90, backpressureLimit: 256 * 1024, closeOnBackpressureLimit: true,
      open: socket => relay.opened(socket),
      message: (socket, value) => { if (typeof value !== 'string') socket.close(1003, 'Text frames required'); else relay.receive(socket, value); },
      close: socket => relay.closed(socket),
    },
  });
  return { server, stop() { relay.dispose(); server.stop(true); } };
}
