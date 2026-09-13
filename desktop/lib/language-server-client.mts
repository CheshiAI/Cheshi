import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { recordValue } from "./codex-service-utils.mts";
import {
  JsonRpcRequestTracker,
  SerializedProcessWriter,
  SingleFlight,
} from "./json-rpc-client-utils.mts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_HEADER_LENGTH = 8_192;
const MAX_MESSAGE_LENGTH = 16 * 1_024 * 1_024;
const MAX_STDERR_LENGTH = 8_000;
type JsonObject = Record<string, unknown>;
interface OpenDocument {
  languageId: string;
  version: number;
}

function responseError(value: unknown) {
  const error = recordValue(value);
  return typeof error?.message === "string" && error.message
    ? error.message
    : "Language server request failed.";
}

function assertActiveChild(
  activeChild: ChildProcessWithoutNullStreams | null,
  expectedChild: ChildProcessWithoutNullStreams,
): asserts activeChild is ChildProcessWithoutNullStreams {
  if (activeChild !== expectedChild) {
    throw new Error("Language server stopped during initialization.");
  }
}

/**
 * Minimal LSP stdio client used for document synchronization and diagnostics.
 * Language-specific behavior belongs in LanguageServerManager definitions.
 */
export class LanguageServerClient {
  stopping: boolean;
  ready: boolean;
  initializeResult: JsonObject | null;
  startFlight: SingleFlight<JsonObject>;
  stderr: string;
  outputBuffer: Buffer;
  failureListeners: Set<(error: Error) => void>;
  diagnosticsListeners: Set<
    (value: {
      uri: string;
      version: number | null;
      diagnostics: unknown[];
    }) => void
  >;
  documents: Map<string, OpenDocument>;
  writer: SerializedProcessWriter;
  requests: JsonRpcRequestTracker;
  child: ChildProcessWithoutNullStreams | null;
  requestTimeoutMs: number;
  clientInfo: { name: string; version: string };
  rootDirectory: string;
  command: {
    executable: string;
    args: string[];
    environment?: NodeJS.ProcessEnv;
  };
  /**
   * @param {{
   *   command: { executable: string, args: string[], environment?: NodeJS.ProcessEnv },
   *   rootDirectory: string,
   *   clientInfo: { name: string, version: string },
   *   requestTimeoutMs?: number,
   * }} options
   */
  constructor({
    command,
    rootDirectory,
    clientInfo,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: {
    command: {
      executable: string;
      args: string[];
      environment?: NodeJS.ProcessEnv;
    };
    rootDirectory: string;
    clientInfo: { name: string; version: string };
    requestTimeoutMs?: number;
  }) {
    this.command = command;
    this.rootDirectory = rootDirectory;
    this.clientInfo = clientInfo;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.requests = new JsonRpcRequestTracker(
      (method) => new Error(`Language server request timed out: ${method}.`),
    );
    this.writer = new SerializedProcessWriter(
      () => this.child?.stdin,
      () => new Error("Language server is not available."),
    );
    this.documents = new Map();
    this.diagnosticsListeners = new Set();
    this.failureListeners = new Set();
    this.outputBuffer = Buffer.alloc(0);
    this.stderr = "";
    /** @type {SingleFlight<JsonObject>} */
    this.startFlight = new SingleFlight();
    this.initializeResult = null;
    this.ready = false;
    this.stopping = false;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  /** @returns {boolean} */
  hasDocument(uri: any): boolean {
    return this.documents.has(uri);
  }

  /**
   * @param {(value: { uri: string, version: number | null, diagnostics: unknown[] }) => void} listener
   * @returns {() => void}
   */
  onDiagnostics(
    listener: (value: {
      uri: string;
      version: number | null;
      diagnostics: unknown[];
    }) => void,
  ): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  /**
   * @param {(error: Error) => void} listener
   * @returns {() => void}
   */
  onDidFail(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async start() {
    if (this.ready && this.child) return this.initializeResult ?? {};
    return await this.startFlight.run(() => this.startInternal());
  }

  /**
   * @param {{ uri: string, languageId: string, version: number, content: string }} document
   */
  async updateDocument({
    uri,
    languageId,
    version,
    content,
  }: {
    uri: string;
    languageId: string;
    version: number;
    content: string;
  }) {
    await this.start();
    const current = this.documents.get(uri);
    this.documents.set(uri, { languageId, version });
    if (current) {
      await this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
      return;
    }
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text: content },
    });
  }

  /**
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   */
  async completion(uri: string, position: { line: number; character: number }) {
    return await this.requestTextDocumentFeature(
      "textDocument/completion",
      "completionProvider",
      uri,
      position,
    );
  }

  /**
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   */
  async hover(uri: string, position: { line: number; character: number }) {
    return await this.requestTextDocumentFeature(
      "textDocument/hover",
      "hoverProvider",
      uri,
      position,
    );
  }

  /**
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   */
  async definition(uri: string, position: { line: number; character: number }) {
    return await this.requestTextDocumentFeature(
      "textDocument/definition",
      "definitionProvider",
      uri,
      position,
    );
  }

  /**
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   */
  async references(uri: string, position: { line: number; character: number }) {
    return await this.requestTextDocumentFeature(
      "textDocument/references",
      "referencesProvider",
      uri,
      position,
      { context: { includeDeclaration: true } },
    );
  }

  /**
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   */
  async signatureHelp(
    uri: string,
    position: { line: number; character: number },
  ) {
    return await this.requestTextDocumentFeature(
      "textDocument/signatureHelp",
      "signatureHelpProvider",
      uri,
      position,
    );
  }

  /**
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   */
  async prepareRename(
    uri: string,
    position: { line: number; character: number },
  ) {
    await this.start();
    const initializeResult = recordValue(this.initializeResult);
    const capabilities = recordValue(initializeResult?.capabilities);
    const provider = capabilities?.renameProvider;
    const options = recordValue(provider);
    if (provider !== true && !options) return null;
    if (options?.prepareProvider !== true) return { defaultBehavior: true };
    return await this.requestRaw("textDocument/prepareRename", {
      textDocument: { uri },
      position,
    });
  }

  /**
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   * @param {string} newName
   */
  async rename(
    uri: string,
    position: { line: number; character: number },
    newName: string,
  ) {
    return await this.requestTextDocumentFeature(
      "textDocument/rename",
      "renameProvider",
      uri,
      position,
      { newName },
    );
  }

  /**
   * @param {string} uri
   * @param {{ start: { line: number, character: number }, end: { line: number, character: number } }} range
   * @param {unknown[]} diagnostics
   */
  async codeActions(
    uri: string,
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    },
    diagnostics: unknown[],
  ) {
    return await this.requestDocumentFeature(
      "textDocument/codeAction",
      "codeActionProvider",
      uri,
      { range, context: { diagnostics, triggerKind: 1 } },
    );
  }

  /** @param {unknown} action */
  async resolveCodeAction(action: unknown) {
    await this.start();
    const initializeResult = recordValue(this.initializeResult);
    const capabilities = recordValue(initializeResult?.capabilities);
    const provider = recordValue(capabilities?.codeActionProvider);
    if (provider?.resolveProvider !== true) return action;
    return await this.requestRaw("codeAction/resolve", action);
  }

  /** @param {string} uri */
  async closeDocument(uri: string) {
    if (!this.documents.delete(uri) || !this.child || !this.ready) return;
    await this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    this.initializeResult = null;
    this.documents.clear();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }

    try {
      await this.requestRaw("shutdown", undefined, 1_000);
      await this.send({ method: "exit" });
    } catch {
      // A language server may exit before acknowledging shutdown.
    }
    try {
      child.stdin.end();
    } catch {
      // The process may already have closed stdin.
    }

    await new globalThis.Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may already have exited.
        }
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (this.child === child) this.child = null;
    this.requests.rejectAll(new Error("Language server stopped."));
  }

  async startInternal(): Promise<JsonObject> {
    this.stopping = false;
    this.outputBuffer = Buffer.alloc(0);
    this.stderr = "";
    const child = spawn(this.command.executable, [...this.command.args], {
      cwd: this.rootDirectory,
      env: { ...process.env, ...this.command.environment, NO_COLOR: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk) => {
      if (this.child === child) this.handleOutput(Buffer.from(chunk));
    });
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
            `Language server exited (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
        ),
      );
    });

    try {
      const rootUri = pathToFileURL(this.rootDirectory).href;
      const initialized = await this.requestRaw("initialize", {
        processId: process.pid,
        clientInfo: this.clientInfo,
        rootUri,
        workspaceFolders: [
          {
            uri: rootUri,
            name: path.basename(this.rootDirectory) || "Workspace",
          },
        ],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
              versionSupport: true,
            },
            completion: {
              completionItem: {
                commitCharactersSupport: true,
                deprecatedSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                insertReplaceSupport: true,
                snippetSupport: false,
                tagSupport: { valueSet: [1] },
              },
              completionList: {
                itemDefaults: [
                  "commitCharacters",
                  "editRange",
                  "insertTextFormat",
                  "insertTextMode",
                  "data",
                ],
              },
              contextSupport: true,
              dynamicRegistration: false,
            },
            hover: {
              contentFormat: ["markdown", "plaintext"],
              dynamicRegistration: false,
            },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            rename: { dynamicRegistration: false, prepareSupport: true },
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    "",
                    "quickfix",
                    "refactor",
                    "refactor.extract",
                    "refactor.inline",
                    "refactor.rewrite",
                    "source",
                    "source.organizeImports",
                  ],
                },
              },
              dataSupport: true,
              disabledSupport: true,
              dynamicRegistration: false,
              isPreferredSupport: true,
              resolveSupport: { properties: ["edit"] },
            },
            signatureHelp: {
              contextSupport: true,
              dynamicRegistration: false,
              signatureInformation: {
                activeParameterSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: { labelOffsetSupport: true },
              },
            },
            synchronization: { didSave: true, dynamicRegistration: false },
          },
          workspace: {
            applyEdit: false,
            configuration: true,
            workspaceEdit: { documentChanges: true },
            workspaceFolders: true,
          },
        },
      });
      await this.send({ method: "initialized", params: {} });
      assertActiveChild(this.child, child);
      this.initializeResult = recordValue(initialized) ?? {};
      this.ready = true;
      return this.initializeResult;
    } catch (error) {
      if (this.child === child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may already have exited.
        }
      }
      throw error;
    }
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {number} [timeoutMs]
   */
  async requestRaw(
    method: string,
    params: unknown = undefined,
    timeoutMs: number = this.requestTimeoutMs,
  ) {
    if (!this.child) throw new Error("Language server is not running.");
    return await this.requests.request(method, params, timeoutMs, (request) =>
      this.send(request),
    );
  }

  /**
   * @param {string} method
   * @param {string} capabilityName
   * @param {string} uri
   * @param {{ line: number, character: number }} position
   * @param {Record<string, unknown>} [extra]
   */
  async requestTextDocumentFeature(
    method: string,
    capabilityName: string,
    uri: string,
    position: { line: number; character: number },
    extra: Record<string, unknown> = {},
  ) {
    return await this.requestDocumentFeature(method, capabilityName, uri, {
      position,
      ...extra,
    });
  }

  /**
   * @param {string} method
   * @param {string} capabilityName
   * @param {string} uri
   * @param {Record<string, unknown>} params
   */
  async requestDocumentFeature(
    method: string,
    capabilityName: string,
    uri: string,
    params: Record<string, unknown>,
  ) {
    await this.start();
    const initializeResult = recordValue(this.initializeResult);
    const capabilities = recordValue(initializeResult?.capabilities);
    const provider = capabilities?.[capabilityName];
    if (provider !== true && !recordValue(provider)) return null;
    return await this.requestRaw(method, {
      textDocument: { uri },
      ...params,
    });
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  async notify(method: string, params: unknown = undefined) {
    await this.start();
    await this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  /** @param {JsonObject} value */
  async send(value: object) {
    const payload = JSON.stringify({ jsonrpc: "2.0", ...value });
    const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
    await this.writer.write(`${header}${payload}`);
  }

  /** @param {Buffer} chunk */
  handleOutput(chunk: Buffer) {
    this.outputBuffer = Buffer.concat([this.outputBuffer, chunk]);
    while (this.outputBuffer.length > 0) {
      let headerEnd = this.outputBuffer.indexOf("\r\n\r\n");
      let separatorLength = 4;
      if (headerEnd < 0) {
        headerEnd = this.outputBuffer.indexOf("\n\n");
        separatorLength = 2;
      }
      if (headerEnd < 0) {
        if (this.outputBuffer.length > MAX_HEADER_LENGTH) {
          this.failCurrent(
            new Error("Language server returned an oversized message header."),
          );
        }
        return;
      }
      const header = this.outputBuffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /^content-length:\s*(\d+)\s*$/im.exec(header);
      const contentLength = lengthMatch ? Number(lengthMatch[1]) : Number.NaN;
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_MESSAGE_LENGTH
      ) {
        this.failCurrent(
          new Error(
            "Language server returned an invalid Content-Length header.",
          ),
        );
        return;
      }
      const bodyStart = headerEnd + separatorLength;
      const bodyEnd = bodyStart + contentLength;
      if (this.outputBuffer.length < bodyEnd) return;
      const body = this.outputBuffer
        .subarray(bodyStart, bodyEnd)
        .toString("utf8");
      this.outputBuffer = this.outputBuffer.subarray(bodyEnd);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        this.failCurrent(new Error("Language server returned invalid JSON."));
        return;
      }
      this.handleMessage(message);
    }
  }

  /** @param {unknown} value */
  handleMessage(value: unknown) {
    const message = recordValue(value);
    if (!message) {
      this.failCurrent(
        new Error("Language server returned an invalid message."),
      );
      return;
    }
    if (
      typeof message.id === "number" &&
      ("result" in message || "error" in message)
    ) {
      if ("error" in message)
        this.requests.reject(
          message.id,
          new Error(responseError(message.error)),
        );
      else this.requests.resolve(message.id, message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (typeof message.id === "number" || typeof message.id === "string") {
      void this.respondToServerRequest(message).catch((error) => {
        this.failCurrent(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      return;
    }
    if (message.method !== "textDocument/publishDiagnostics") return;
    const params = recordValue(message.params);
    if (typeof params?.uri !== "string" || !Array.isArray(params.diagnostics))
      return;
    const documentVersion = this.documents.get(params.uri)?.version ?? null;
    const version =
      typeof params.version === "number" && Number.isInteger(params.version)
        ? params.version
        : documentVersion;
    for (const listener of this.diagnosticsListeners) {
      listener({ uri: params.uri, version, diagnostics: params.diagnostics });
    }
  }

  /** @param {JsonObject} message */
  async respondToServerRequest(message: JsonObject) {
    const params = recordValue(message.params);
    let result;
    switch (message.method) {
      case "workspace/configuration":
        result = Array.isArray(params?.items)
          ? params.items.map(() => null)
          : [];
        break;
      case "workspace/workspaceFolders": {
        const uri = pathToFileURL(this.rootDirectory).href;
        result = [
          { uri, name: path.basename(this.rootDirectory) || "Workspace" },
        ];
        break;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        result = null;
        break;
      case "workspace/applyEdit":
        result = {
          applied: false,
          failureReason:
            "Cheshi does not apply language-server workspace edits yet.",
        };
        break;
      case "window/showMessageRequest":
        result = null;
        break;
      default:
        await this.send({
          id: message.id,
          error: {
            code: -32601,
            message: `Unsupported language server request: ${message.method}`,
          },
        });
        return;
    }
    await this.send({ id: message.id, result });
  }

  /** @param {Error} error */
  failCurrent(error: Error) {
    const child = this.child;
    if (!child) return;
    this.failChild(child, error);
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }

  /**
   * @param {import('node:child_process').ChildProcess} child
   * @param {Error} error
   */
  failChild(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.initializeResult = null;
    this.documents.clear();
    this.requests.rejectAll(error);
    if (this.stopping) return;
    for (const listener of this.failureListeners) listener(error);
  }
}
