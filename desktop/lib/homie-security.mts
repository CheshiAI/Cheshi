import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const profile = '/etc/apparmor.d/cheshi-codex-bwrap';
const loaded = "grep -Fxq 'cheshi-codex-bwrap (enforce)' /sys/kernel/security/apparmor/profiles";
type Command = (args: string[], input?: string) => Promise<string>;

/** Only the default local Colima VM is managed by Homies setup. */
export class HomieSecurity {
  private readonly source: string;
  private readonly command: Command;
  constructor(source: string, command: Command) { this.source = source; this.command = command; }
  private run(script: string, input?: string) {
    return this.command(['--profile', 'default', 'ssh', '--', 'sudo', '-n', 'sh', '-c', script], input);
  }
  async ready(): Promise<boolean> {
    const expected = createHash('sha256').update(await readFile(this.source)).digest('hex');
    const result = await this.run(`if ${loaded} && test -f ${profile}; then sha256sum ${profile}; fi`);
    return result.trim().split(/\s+/)[0] === expected;
  }
  async prepare(): Promise<void> {
    if (await this.ready()) return;
    const content = await readFile(this.source, 'utf8');
    // Profile text travels over stdin, never through shell interpolation or argv.
    await this.run(`set -eu
command -v apparmor_parser >/dev/null
temporary=$(mktemp /etc/apparmor.d/.cheshi-codex-bwrap.XXXXXX)
trap 'rm -f "$temporary"' EXIT
cat > "$temporary"
apparmor_parser -r -W "$temporary"
chmod 644 "$temporary"
mv -f "$temporary" ${profile}`, content);
  }
}
