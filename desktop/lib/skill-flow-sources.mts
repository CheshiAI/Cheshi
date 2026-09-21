import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';

export interface SourceDocument { url: string; content: string }
export type SourceReader = (url: string, signal?: AbortSignal) => Promise<SourceDocument>;

export function sourceUrl(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.href.length > 1500) throw new TypeError('Invalid source URL.');
  url.hash = '';
  return url;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== undefined && b !== undefined && a > 0 && a < 224 && a !== 10 && a !== 127
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 198 && (b === 18 || b === 19));
  }
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
}

function plainText(raw: string, html: boolean): string {
  let value = raw;
  if (html) {
    const main = raw.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    value = (main?.[1] ?? raw).replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, match =>
        ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[match] ?? match);
  }
  value = value.replace(/\s+/g, ' ').trim();
  while (Buffer.byteLength(JSON.stringify(value)) > 18_000) value = value.slice(0, Math.floor(value.length * 0.9));
  if (!value) throw new Error('Source returned no readable content.');
  return value;
}

/** Fetch bounded public evidence without cookies; pin DNS so redirects cannot reach local services. */
export const readResearchSource: SourceReader = async (value, signal) => {
  const timeout = AbortSignal.timeout(15_000);
  const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = sourceUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    operationSignal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookup(host, { all: true });
    operationSignal.throwIfAborted();
    if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new Error('Source is not a public address.');
    const response = await new Promise<{ redirect: string } | { content: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, {
        signal: operationSignal, headers: { Accept: 'text/markdown, text/plain, text/html', 'User-Agent': 'Cheshi-Research/1.0' },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      }, message => {
        if ([301, 302, 303, 307, 308].includes(message.statusCode ?? 0) && message.headers.location) {
          message.resume(); resolve({ redirect: message.headers.location }); return;
        }
        const type = message.headers['content-type'] ?? '';
        if (message.statusCode !== 200 || !/^text\/(?:plain|markdown|html)\b/i.test(type)) {
          message.resume(); reject(new Error('Source could not be read as text.')); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        message.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1_000_000) request.destroy(new Error('Source exceeds the read limit.'));
          else chunks.push(chunk);
        });
        message.once('error', reject);
        message.once('end', () => {
          try { resolve({ content: plainText(Buffer.concat(chunks).toString('utf8'), type.includes('html')) }); }
          catch (error) { reject(error); }
        });
      });
      request.once('error', reject);
    });
    if ('content' in response) return { url: url.href, content: response.content };
    url = sourceUrl(new URL(response.redirect, url).href);
  }
  throw new Error('Too many source redirects.');
};
