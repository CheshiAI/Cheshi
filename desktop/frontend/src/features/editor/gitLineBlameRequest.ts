import type { GitLineBlame } from '../../../../shared/git-line-blame';

/** Debounce pointer movement and serialize requests; only the latest hover may publish. */
export class GitLineBlameRequest {
  private line: number | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private ready = false;
  private readonly read: (line: number) => Promise<GitLineBlame>;
  private readonly publish: (line: number, result: GitLineBlame) => void;
  private readonly delay: number;

  constructor(read: (line: number) => Promise<GitLineBlame>, publish: (line: number, result: GitLineBlame) => void, delay = 300) {
    this.read = read;
    this.publish = publish;
    this.delay = delay;
  }

  hover(line: number | null): boolean {
    if (line === this.line) return false;
    this.reset();
    this.line = line;
    if (line !== null) this.timer = setTimeout(() => {
      this.ready = true;
      void this.run();
    }, this.delay);
    return true;
  }

  reset(): void {
    clearTimeout(this.timer);
    this.generation++;
    this.line = null;
    this.ready = false;
  }

  private async run(): Promise<void> {
    if (this.busy || !this.ready || this.line === null) return;
    this.ready = false;
    this.busy = true;
    const generation = this.generation;
    const line = this.line;
    let result: GitLineBlame;
    try { result = await this.read(line); }
    catch { result = { status: 'unavailable' }; }
    this.busy = false;
    if (generation === this.generation) this.publish(line, result);
    if (this.ready) void this.run();
  }
}
