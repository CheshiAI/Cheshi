import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const text = '한글\u2028줄 구분\u2029문단 구분🙂';

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
  } else if (request.method === 'fixture/partial') {
    process.stdout.write(JSON.stringify({ method: 'fixture/partial-ready' }) + '\n' + '{"id":');
  } else if (request.method === 'fixture/malformed') {
    process.stdout.write('invalid json\n' + JSON.stringify({ method: 'fixture/ignored' }) + '\n');
  }
});
