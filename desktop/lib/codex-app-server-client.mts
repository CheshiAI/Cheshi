import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DEFAULT_CODEX_SHUTDOWN_TIMEOUTS, shutdownCodexAppServer, type CodexShutdownTimeouts } from './codex-app-server-shutdown.mts';

import { recordValue } from "./codex-service-utils.mts";
import {
  JsonRpcRequestTracker,
  SerializedProcessWriter,
  SingleFlight,
} from "./json-rpc-client-utils.mts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_LENGTH = 8_000;

export class CodexAppServerStoppedError extends Error {
  constructor(message = 'Codex App Server stopped.') {
    super(message);
    this.name = 'CodexAppServerStoppedError';
  }
}

type JsonObject = Record<string, unknown>;
interface CodexAppServerClientOptions {
  command: {
    executable: string;
    args: string[];
    environment: Record<string, string | undefined>;
  };
  cwd: string;
  clientInfo: { name: string; title: string; version: string };
  capabilities?: JsonObject;
  requestTimeoutMs?: number;
  shutdownTimeouts?: Readonly<CodexShutdownTimeouts>;
}
function responseError(value: unknown) {
  const record = recordValue(value);
  const error = new Error(typeof record?.message === "string" && record.message
    ? record.message : "Codex App Server request failed.");
  error.name = "CodexRequestRejectedError";
  return error;
}

/**
 * @param {unknown} activeChild
 * @param {unknown} expectedChild
 */
function assertActiveChild(
  activeChild: ChildProcessWithoutNullStreams | null,
  expectedChild: ChildProcessWithoutNullStreams,
): asserts activeChild is ChildProcessWithoutNullStreams {
  if (activeChild !== expectedChild) {
    throw new CodexAppServerStoppedError('Codex App Server stopped during initialization.');
  }
}

export class CodexAppServerClient {
  private stopFlight: Promise<void> | null = null;
  private readonly shutdownTimeouts: Readonly<CodexShutdownTimeouts>;
  stopping: boolean;
  ready: boolean;
  stderr: string;
  initializeResult: JsonObject | null;
  startFlight: SingleFlight<JsonObject>;
  writer: SerializedProcessWriter;
  requests: JsonRpcRequestTracker;
  failureListeners: Set<(error: Error) => void>;
  requestListeners: Set<(value: JsonObject) => void>;
  notificationListeners: Set<(value: JsonObject) => void>;
  output: { close(): void } | null;
  child: ChildProcessWithoutNullStreams | null;
  requestTimeoutMs: number;
  capabilities: JsonObject | undefined;
  clientInfo: { name: string; title: string; version: string };
  cwd: string;
  command: {
    executable: string;
    args: string[];
    environment: Record<string, string | undefined>;
  };
  /** @param {CodexAppServerClientOptions} options */
  constructor({
    command,
    cwd,
    clientInfo,
    capabilities,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    shutdownTimeouts = DEFAULT_CODEX_SHUTDOWN_TIMEOUTS,
  }: CodexAppServerClientOptions) {
    this.command = command;
    this.cwd = cwd;
    this.clientInfo = clientInfo;
    this.capabilities = capabilities;
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownTimeouts = shutdownTimeouts;
    this.child = null;
    this.output = null;
    /** @type {Set<(value: JsonObject) => void>} */
    this.notificationListeners = new Set();
    /** @type {Set<(value: JsonObject) => void>} */
    this.requestListeners = new Set();
    /** @type {Set<(error: Error) => void>} */
    this.failureListeners = new Set();
    this.requests = new JsonRpcRequestTracker(
      (method) => new Error(`Codex App Server request timed out: ${method}.`),
    );
    this.writer = new SerializedProcessWriter(
      () => this.child?.stdin,
      () => new Error("Codex App Server is not available."),
    );
    /** @type {SingleFlight<JsonObject>} */
    this.startFlight = new SingleFlight();
    /** @type {JsonObject | null} */
    this.initializeResult = null;
    this.stderr = "";
    this.ready = false;
    this.stopping = false;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  /**
   * @param {(value: JsonObject) => void} listener
   * @returns {() => void}
   */
  onNotification(listener: (value: JsonObject) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /**
   * @param {(value: JsonObject) => void} listener
   * @returns {() => void}
   */
  onRequest(listener: (value: JsonObject) => void): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  /**
   * @param {(error: Error) => void} listener
   * @returns {() => void}
   */
  onDidFail(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  /** @returns {Promise<JsonObject>} */
  async start(): Promise<JsonObject> {
    if (this.stopFlight) {
      await this.stopFlight;
      // Let an interrupted initialization settle before starting a new child.
      await this.startFlight.operation?.catch(() => undefined);
    }
    if (this.ready && this.child) return this.initializeResult ?? {};
    return await this.startFlight.run(() => this.startInternal());
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<unknown>}
   */
  async request(
    method: string,
    params: unknown = undefined,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<unknown> {
    await this.start();
    return await this.requestRaw(method, params, timeoutMs);
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  async notify(method: string, params: unknown = undefined) {
    await this.start();
    await this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  /**
   * @param {string | number} id
   * @param {unknown} result
   * @returns {Promise<void>}
   */
  async respond(id: string | number, result: unknown): Promise<void> {
    await this.start();
    await this.send({ id, result });
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    this.stopping = true;
    this.ready = false;
    this.initializeResult = null;
    const child = this.child;
    this.child = null;
    this.output?.close();
    this.output = null;
    this.requests.rejectAll(new CodexAppServerStoppedError());
    if (!child) return Promise.resolve();
    return this.shutdownChild(child);
  }

  private shutdownChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    // Keep a failed shutdown latched so start() cannot orphan it behind a replacement.
    this.stopFlight = shutdownCodexAppServer(child, this.shutdownTimeouts).then(() => {
      this.stopFlight = null;
    });
    return this.stopFlight;
  }

  async startInternal(): Promise<JsonObject> {
    this.stopping = false;
    this.stderr = "";
    const child = spawn(this.command.executable, [...this.command.args], {
      cwd: this.cwd,
      env: { ...process.env, ...this.command.environment, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.output = this.readOutput(child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    child.once("error", (error) => this.failChild(child, error));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.failChild(
        child,
        new Error(
          detail ||
            `Codex App Server exited (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
        ),
      );
    });

    try {
      const initializeParams = {
        clientInfo: this.clientInfo,
        ...(this.capabilities ? { capabilities: this.capabilities } : {}),
      };
      const initialized = await this.requestRaw("initialize", initializeParams);
      await this.send({ method: "initialized", params: {} });
      assertActiveChild(this.child, child);
      this.initializeResult = recordValue(initialized) ?? {};
      this.ready = true;
      return this.initializeResult;
    } catch (error) {
      if (this.child === child) {
        // Keep the initialization error; a cleanup failure remains latched in stopFlight.
        await this.stop().catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<unknown>}
   */
  async requestRaw(
    method: string,
    params: unknown = undefined,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (!this.child) throw new Error("Codex App Server is not running.");
    return await this.requests.request(method, params, timeoutMs, (request) =>
      this.send(request),
    );
  }

  async send(value: unknown) {
    await this.writer.write(`${JSON.stringify(value)}\n`);
  }

  private readOutput(child: ChildProcessWithoutNullStreams): { close(): void } {
    let pending = "";
    // Decode across byte chunks, then split only on the JSON-RPC transport's LF.
    // readline also treats legal JSON string characters U+2028/U+2029 as endings.
    child.stdout.setEncoding("utf8");
    const onData = (chunk: string) => {
      if (this.child !== child) return;
      pending += chunk;
      let start = 0;
      let end = pending.indexOf("\n", start);
      while (end !== -1) {
        this.handleLine(pending.slice(start, end));
        if (this.child !== child) return;
        start = end + 1;
        end = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    };
    child.stdout.on("data", onData);
    return {
      close() {
        child.stdout.off("data", onData);
        pending = "";
      },
    };
  }

  handleLine(line: string) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      this.failCurrent(new Error("Codex App Server returned invalid JSON."));
      return;
    }
    const envelope = recordValue(value);
    if (!envelope) {
      this.failCurrent(
        new Error("Codex App Server returned an invalid message."),
      );
      return;
    }

    if (
      typeof envelope.id === "number" &&
      ("result" in envelope || "error" in envelope)
    ) {
      if ("error" in envelope)
        this.requests.reject(
          envelope.id,
          responseError(envelope.error),
        );
      else this.requests.resolve(envelope.id, envelope.result);
      return;
    }

    if (typeof envelope.method !== "string") return;
    const listeners =
      typeof envelope.id === "number" || typeof envelope.id === "string"
        ? this.requestListeners
        : this.notificationListeners;
    for (const listener of listeners) listener(envelope);
  }

  failCurrent(error: Error) {
    const child = this.child;
    if (!child) return;
    // Retain ownership before failChild clears the transport and notifies listeners.
    void this.shutdownChild(child).catch(() => undefined);
    this.failChild(child, error);
  }

  failChild(child: ChildProcessWithoutNullStreams | null, error: Error) {
    if (this.child !== child) return;
    this.child = null;
    this.output?.close();
    this.output = null;
    this.ready = false;
    this.initializeResult = null;
    this.requests.rejectAll(error);
    if (this.stopping) return;
    for (const listener of this.failureListeners) listener(error);
  }
}
