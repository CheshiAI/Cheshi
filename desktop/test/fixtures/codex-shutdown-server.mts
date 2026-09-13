import readline from 'node:readline';

const mode = process.argv[2];
// Keep running after stdin closes so tests exercise the signal path explicitly.
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  if (mode === 'graceful') process.exit(0);
});

readline.createInterface({ input: process.stdin }).on('line', (line: string) => {
  const request = JSON.parse(line) as { id?: number; method?: string };
  if (request.method !== 'initialize') return;
  if (mode === 'hold') {
    process.stdout.write(JSON.stringify({ method: 'fixture/ready', params: {} }) + '\n');
  } else if (mode === 'malformed') {
    process.stdout.write('invalid json\n');
  } else if (mode === 'rejected') {
    process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'Initialization refused' } }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'shutdown-test' } }) + '\n');
  }
});
