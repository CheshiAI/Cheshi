import { spawn } from 'node:child_process';

// The parent records our process group before opening this gate. If it dies first,
// stdin closes and no command is allowed to start writing the staging directory.
let permission = '';
for await (const chunk of process.stdin) permission += String(chunk);
if (permission !== 'run\n') process.exit(1);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Missing build command.');
const child = spawn(command, args, { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
