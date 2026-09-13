import { ansiColorsEnabled } from '../ui/color';
import { getGlyphs } from '../ui/glyphs';
import { Writable } from 'stream';

// Decided once, before `--color`/`--no-color` are stripped from argv below
// (#1281). Piped/redirected stdout, NO_COLOR, or --no-color -> plain output.
export const COLORS_ENABLED = ansiColorsEnabled();

type Clack = typeof import('@clack/prompts');

/**
 * Bun's `node:util.styleText()` currently emits ANSI escapes even when stdout
 * is piped and NO_COLOR is set. Clack uses that API internally, so route its
 * output through a stripping writer whenever CodeGraph's color policy is off.
 */
class PlainClackOutput extends Writable {
  constructor(private readonly target: NodeJS.WriteStream) {
    super();
  }

  //noinspection JSUnusedGlobalSymbols
  get isTTY(): boolean | undefined {
    return this.target.isTTY;
  }

  //noinspection JSUnusedGlobalSymbols
  get columns(): number | undefined {
    return this.target.columns;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.target.write(Bun.stripANSI(chunk.toString()), callback);
  }
}

export async function loadClack(): Promise<Clack> {
  const clack = await import('@clack/prompts');
  if (COLORS_ENABLED) return clack;

  const output = new PlainClackOutput(process.stdout);
  const withOutput = <T extends object>(options?: T): T & { output: Writable } =>
    ({ ...options, output }) as unknown as T & { output: Writable };
  const log = {
    ...clack.log,
    message: (message?: string | string[], options?: Parameters<Clack['log']['message']>[1]) =>
      clack.log.message(message, withOutput(options)),
    info: (message: string, options?: Parameters<Clack['log']['info']>[1]) =>
      clack.log.info(message, withOutput(options)),
    success: (message: string, options?: Parameters<Clack['log']['success']>[1]) =>
      clack.log.success(message, withOutput(options)),
    step: (message: string, options?: Parameters<Clack['log']['step']>[1]) =>
      clack.log.step(message, withOutput(options)),
    warn: (message: string, options?: Parameters<Clack['log']['warn']>[1]) =>
      clack.log.warn(message, withOutput(options)),
    warning: (message: string, options?: Parameters<Clack['log']['warning']>[1]) =>
      clack.log.warning(message, withOutput(options)),
    error: (message: string, options?: Parameters<Clack['log']['error']>[1]) =>
      clack.log.error(message, withOutput(options)),
  };

  // Confine the facade cast to this integration boundary. The wrapped methods
  // retain Clack's arguments and return values; they only inject `output`.
  return {
    ...clack,
    log,
    intro: (title, options) => clack.intro(title, withOutput(options)),
    outro: (message, options) => clack.outro(message, withOutput(options)),
    note: (message, title, options) => clack.note(message, title, withOutput(options)),
    confirm: (options) => clack.confirm(withOutput(options)),
    select: (options) => clack.select(withOutput(options)),
  } as Clack;
}

// Lazy-load heavy modules (CodeGraph, runInstaller) to keep CLI startup fast.
export async function loadCodeGraph(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const [red, reset] = COLORS_ENABLED ? ['\x1b[31m', '\x1b[0m'] : ['', ''];
    console.error(`${red}${getGlyphs().err}${reset} Failed to load CodeGraph modules.`);
    console.error(`\n  Bun: ${process.versions.bun ?? 'not detected'}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Check the local base with: bun run check\n');
    process.exit(1);
  }
}
