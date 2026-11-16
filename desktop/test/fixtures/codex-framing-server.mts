import readline from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const text = '한글\u2028줄 구분\u2029문단 구분🙂';

async function writeChunks(response: Buffer) {
  // Deliberately use an odd size so UTF-8 characters can cross write boundaries.
  for (let start = 0; start < response.length; start += 8191) {
    if (!process.stdout.write(response.subarray(start, start + 8191))) {
      await once(process.stdout, 'drain');
    }
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line: string) => {
  const request = JSON.parse(line) as { id?: number; method?: string };
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
  } else if (request.method === 'thread/read') {
    const response = Buffer.from(JSON.stringify({ id: request.id, result: { text } }) + '\r\n');
    // Each split is inside a multibyte character; writes are separated to exercise decoding.
    const boundaries = ['한', '\u2028', '\u2029', '🙂'].map(value => response.indexOf(Buffer.from(value)) + 1);
    let start = 0;
    for (const end of boundaries) {
      process.stdout.write(response.subarray(start, end));
      await delay(10);
      start = end;
    }
    process.stdout.write(Buffer.concat([
      response.subarray(start),
      Buffer.from(JSON.stringify({ method: 'fixture/complete', params: { text } }) + '\n'),
    ]));
  } else if (request.method === 'fixture/large') {
    const largeText = `${text}\n`.repeat(100_000);
    await writeChunks(Buffer.from(JSON.stringify({ id: request.id, result: { text: largeText } })));
    // The final CR and LF arrive separately, followed by complete frames and
    // the beginning of a new frame in the same chunk.
    process.stdout.write('\r');
    await delay(10);
    process.stdout.write('\n' + JSON.stringify({ method: 'fixture/after-large', params: { order: 1 } }) + '\n' + '{"method":"fixture/');
    await delay(10);
    process.stdout.write('tail","params":{"order":2}}\n');
  } else if (request.method === 'fixture/partial') {
    process.stdout.write(JSON.stringify({ method: 'fixture/partial-ready' }) + '\n' + '{"id":');
  } else if (request.method === 'fixture/malformed') {
    process.stdout.write('invalid json\n' + JSON.stringify({ method: 'fixture/ignored' }) + '\n');
  }
});
