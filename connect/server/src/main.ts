import { fileURLToPath } from 'node:url';
import { startConnectionServer } from './server.ts';
const origin = process.env.CHESHI_CONNECT_ORIGIN;
if (!origin) throw new Error('Set CHESHI_CONNECT_ORIGIN to the public HTTPS origin (loopback HTTP for development).');
const service = startConnectionServer({ origin, port: Number(process.env.PORT ?? 8788),
  assets: fileURLToPath(new URL('../../client/dist', import.meta.url)),
  hostname: process.env.CHESHI_CONNECT_BIND ?? '127.0.0.1' });
console.log(`Cheshi connection service listening on ${service.server.hostname}:${service.server.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { service.stop(); process.exit(0); });
