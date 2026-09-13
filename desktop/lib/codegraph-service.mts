import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from 'node:path';

interface ProcessCommand {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
}

export function createCodeGraphCommands(options: {
  packaged: boolean;
  resourcesPath: string;
  rootDirectory: string;
  bunExecutable?: string;
}) {
  const command = (binary: string, source: string): ProcessCommand => options.packaged
    ? {
      executable: path.join(options.resourcesPath, 'runtime', `${process.platform}-${process.arch}`, `${binary}${process.platform === 'win32' ? '.exe' : ''}`),
      args: [],
    }
    : {
      executable: options.bunExecutable?.trim() || 'bun',
      args: [path.join(options.rootDirectory, source)],
    };
  return {
    viewer: (environment: NodeJS.ProcessEnv): ProcessCommand => ({
      ...command('cheshi-codegraph-host', 'desktop/backend/codegraph-host.ts'),
      environment,
    }),
    cli: (): ProcessCommand => command('cheshi-cli', 'cli/cheshi-cli.ts'),
  };
}

type Logger = (event: string, details: Record<string, unknown>) => void;

class ManagedChildProcess {
  child: ChildProcess | null;
  constructor() {
    this.child = null;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new globalThis.Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // It may already have exited.
    }
    await exited;
  }
}

export class CodeGraphService extends ManagedChildProcess {
  log: Logger;
  command: ProcessCommand;
  constructor({ command, log }: { command: ProcessCommand; log: Logger }) {
    super();
    this.command = command;
    this.log = log;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  async start(
    projectRoot: string,
    staticRoot: string,
    codeGraphDataRoot: string,
  ): Promise<string> {
    await this.stop();
    const child = spawn(
      this.command.executable,
      [...this.command.args, projectRoot, staticRoot],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...this.command.environment,
          CODEGRAPH_DATA_ROOT: codeGraphDataRoot,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
    });

    return await new globalThis.Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("CodeGraph server did not start within 30 seconds."));
        void this.stop();
      }, 30_000);
      let settled = false;
      const output = readline.createInterface({ input: child.stdout });
      output.on("line", (line) => {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          this.log("codegraph-output", { line: line.slice(0, 500) });
          return;
        }
        if (
          !settled &&
          value?.type === "ready" &&
          typeof value.url === "string"
        ) {
          settled = true;
          clearTimeout(timeout);
          resolve(value.url);
        }
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const exitedUnexpectedly = this.child === child;
        if (exitedUnexpectedly) {
          this.child = null;
          this.log("codegraph-exited", { code, signal });
        }
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(
            stderr.trim() ||
              `CodeGraph server exited with code ${code ?? "none"}.`,
          ),
        );
      });
    });
  }
}

export class CodeGraphIndexer extends ManagedChildProcess {
  command: ProcessCommand;
  constructor({ command }: { command: ProcessCommand }) {
    super();
    this.command = command;
  }

  async reindex(projectRoot: string, codeGraphDataRoot: string): Promise<void> {
    return this.run(projectRoot, codeGraphDataRoot, ['index', '--quiet']);
  }

  async initialize(projectRoot: string, codeGraphDataRoot: string): Promise<void> {
    return this.run(projectRoot, codeGraphDataRoot, ['init']);
  }

  private async run(projectRoot: string, codeGraphDataRoot: string, args: string[]): Promise<void> {
    if (this.child)
      throw new Error("CodeGraph indexing is already in progress.");

    const child = spawn(
      this.command.executable,
      [...this.command.args, "codegraph", ...args, projectRoot],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...this.command.environment,
          CODEGRAPH_DATA_ROOT: codeGraphDataRoot,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
    });
    // Init reports failures through its progress output as well as stderr.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
    });

    await new globalThis.Promise<void>((resolve, reject) => {
      let settled = false;
      child.once("error", (error) => {
        if (this.child === child) this.child = null;
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve();
          return;
        }
        const reason =
          stderr.trim() ||
          (signal
            ? `CodeGraph indexing stopped with signal ${signal}.`
            : `CodeGraph indexing exited with code ${code ?? "none"}.`);
        reject(new Error(reason));
      });
    });
  }
}
