import { CodexAppServerClient, CodexAppServerStoppedError } from './codex-app-server-client.mts';
import { recordValue } from './codex-service-utils.mts';

type ClientOptions = ConstructorParameters<typeof CodexAppServerClient>[0];
type PrepareCommand = (command: ClientOptions['command']) => Promise<string[]>;

/** Owns the transports for one workspace, excluding account-only login workers. */
export class CodexAccountClients {
  readonly clients = new Set<AccountClient>();
  environment: Record<string, string | undefined>;
  private readonly defaultHome: string | undefined;
  generation = 0;
  switching = false;
  private closed = false;
  readonly prepareCommand: PrepareCommand | undefined;

  constructor(environment: Record<string, string | undefined>, prepareCommand?: PrepareCommand) {
    this.environment = environment;
    this.defaultHome = environment.CODEX_HOME;
    this.prepareCommand = prepareCommand;
  }

  commandArgs(args: string[]): string[] {
    return this.environment.CODEX_HOME === this.defaultHome ? [...args]
      : [...args, '-c', 'cli_auth_credentials_store="file"'];
  }

  create(options: ClientOptions): AccountClient {
    this.assertAvailable();
    const client = new AccountClient(this, options);
    this.clients.add(client);
    return client;
  }

  assertAvailable(): void {
    if (this.closed) throw new Error('The workspace has closed.');
    if (this.switching) throw new Error('Wait for the account switch to finish.');
  }

  async change(environment: Record<string, string | undefined>, retained: AccountClient[], reset: () => Promise<void>): Promise<void> {
    this.assertAvailable();
    if ([...this.clients].some(client => client.busy)) throw new Error('Wait for all Codex requests and responses to finish before switching accounts.');
    this.switching = true;
    try {
      const results = await Promise.allSettled([...this.clients].map(client => client.stop()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      await reset();
      if (this.closed) throw new Error('The workspace has closed.');
      this.environment = { ...environment };
      this.generation += 1;
      for (const client of retained) client.rebind();
    } finally { this.switching = false; }
  }

  async stop(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.clients].map(client => client.stop()));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

export class AccountClient extends CodexAppServerClient {
  private readonly pool: CodexAccountClients;
  private readonly originalArgs: string[];
  private generation: number;
  private calls = 0;
  private readonly turns = new Set<string>();
  private preparationRevision = 0;

  constructor(pool: CodexAccountClients, options: ClientOptions) {
    super({ ...options, command: { ...options.command, args: pool.commandArgs(options.command.args), environment: { ...pool.environment } } });
    this.pool = pool;
    this.originalArgs = [...options.command.args];
    this.generation = pool.generation;
    this.onNotification(value => {
      const params = recordValue(value.params);
      const threadId = params?.threadId;
      if (typeof threadId !== 'string') return;
      if (value.method === 'turn/started') this.turns.add(threadId);
      if (value.method === 'turn/completed') this.turns.delete(threadId);
    });
    this.onDidFail(() => this.turns.clear());
  }

  get busy(): boolean { return this.calls > 0 || this.turns.size > 0 || this.startFlight.operation !== null; }

  rebind(): void {
    this.generation = this.pool.generation;
    this.command.environment = { ...this.pool.environment };
    this.command.args = this.pool.commandArgs(this.originalArgs);
  }

  override async start(): Promise<Record<string, unknown>> {
    this.pool.assertAvailable();
    if (this.generation !== this.pool.generation) throw new Error('This conversation belongs to the previous account. Open a new chat.');
    this.pool.clients.add(this);
    return super.start();
  }

  override async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.calls += 1;
    try { return await super.request(method, params, timeoutMs); }
    finally { this.calls -= 1; }
  }

  override async startInternal(): Promise<Record<string, unknown>> {
    if (this.pool.prepareCommand) {
      const revision = this.preparationRevision;
      const args = await this.pool.prepareCommand(this.command);
      if (revision !== this.preparationRevision) throw new CodexAppServerStoppedError();
      this.pool.assertAvailable();
      this.command.args = this.pool.commandArgs([...this.originalArgs, ...args]);
    }
    return super.startInternal();
  }

  override async stop(): Promise<void> {
    this.preparationRevision += 1;
    await super.stop();
    this.turns.clear();
    this.pool.clients.delete(this);
  }
}
