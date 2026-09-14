import { recordValue } from "./codex-service-utils.mts";
import { LanguageServerClient } from "./language-server-client.mts";
import {
  findExecutable,
  isExecutable,
  normalizeBundledCommand,
  resolveNodeScriptCommand,
} from "./language-server-command.mts";
import {
  isInsideWorkspace,
  projectRootFor,
  requireCodeActionFeature,
  requireDocumentFeature,
  requireDocumentUpdate,
  requireRelativePath,
  requireRenameFeature,
  resolveDocumentPath,
} from "./language-server-documents.mts";
import {
  normalizeCodeActionResult,
  normalizeCompletionResult,
  normalizeDefinitionResult,
  normalizeHoverResult,
  normalizePrepareRenameResult,
  normalizeRenameResult,
  normalizeSignatureHelpResult,
} from "./language-server-results.mts";
import {
  defaultDefinitions,
  LANGUAGE_SERVER_MODES,
  readSettings,
  requireDefinition,
  requireLanguage,
  requireSetting,
  writeSettings,
} from "./language-server-settings.mts";
import type {
  DiagnosticsListener,
  DocumentUpdate,
  LanguageServerDefinition,
  LanguageServerMode,
  LanguageServerSettings,
  ResolvedCommand,
} from "./language-server-types.mts";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export { typescriptLanguageIdForPath } from "./language-server-settings.mts";

export class LanguageServerManager {
  diagnosticsListeners: Set<DiagnosticsListener>;
  errors: Map<string, string>;
  clients: Map<string, LanguageServerClient>;
  settings: LanguageServerSettings;
  requestTimeoutMs: number | undefined;
  bundledCommands: { [x: string]: unknown };
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  definitions: Record<string, LanguageServerDefinition>;
  clientInfo: { name: string; version: string };
  settingsPath: string;
  workspaceRoot: string;
  /**
   * @param {{
   *   workspaceRoot: string,
   *   settingsPath: string,
   *   clientInfo: { name: string, version: string },
   *   definitions?: Record<string, {
   *     displayName: string,
   *     serverName: string,
   *     command: string,
   *     args: string[],
   *     rootMarkers: string[],
   *     languageId: (filePath: string) => string,
   *   }>,
   *   homeDirectory?: string,
   *   environment?: NodeJS.ProcessEnv,
   *   bundledCommands?: Record<string, {
   *     executable: string,
   *     args: string[],
   *     environment?: NodeJS.ProcessEnv,
   *     availabilityPath: string,
   *     displayPath?: string,
   *   }>,
   *   requestTimeoutMs?: number,
   * }} options
   */
  constructor({
    workspaceRoot,
    settingsPath,
    clientInfo,
    definitions = defaultDefinitions,
    homeDirectory = os.homedir(),
    environment = process.env,
    bundledCommands = {},
    requestTimeoutMs,
  }: {
    workspaceRoot: string;
    settingsPath: string;
    clientInfo: { name: string; version: string };
    definitions?: Record<
      string,
      {
        displayName: string;
        serverName: string;
        command: string;
        args: string[];
        rootMarkers: string[];
        languageId: (filePath: string) => string;
      }
    >;
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    bundledCommands?: Record<
      string,
      {
        executable: string;
        args: string[];
        environment?: NodeJS.ProcessEnv;
        availabilityPath: string;
        displayPath?: string;
      }
    >;
    requestTimeoutMs?: number;
  }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.settingsPath = path.resolve(settingsPath);
    this.clientInfo = clientInfo;
    this.definitions = definitions;
    this.homeDirectory = path.resolve(homeDirectory);
    this.environment = environment;
    this.bundledCommands = { ...bundledCommands };
    this.requestTimeoutMs = requestTimeoutMs;
    const loadedSettings = readSettings(this.settingsPath, definitions);
    this.settings = loadedSettings.settings;
    if (loadedSettings.shouldPersist)
      writeSettings(this.settingsPath, this.settings);
    this.clients = new Map();
    this.errors = new Map();
    this.diagnosticsListeners = new Set();
  }

  /**
   * @param {(value: { language: string, path: string, version: number | null, diagnostics: unknown[] }) => void} listener
   * @returns {() => void}
   */
  onDiagnostics(
    listener: (value: {
      language: string;
      path: string;
      version: number | null;
      diagnostics: unknown[];
    }) => void,
  ): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  getStatuses() {
    return Object.keys(this.definitions).map((language) =>
      this.statusFor(language, this.workspaceRoot),
    );
  }

  /**
   * @param {{ language: unknown, mode: unknown, executable?: unknown }} value
   */
  async configure(value: {
    language: unknown;
    mode: unknown;
    executable?: unknown;
  }) {
    const request = recordValue(value);
    if (!request)
      throw new TypeError("Language server configuration must be an object.");
    const language = requireLanguage(request.language, this.definitions);
    if (
      typeof request.mode !== "string" ||
      !LANGUAGE_SERVER_MODES.has(request.mode as LanguageServerMode)
    ) {
      throw new TypeError("Language server mode is invalid.");
    }
    let executable = null;
    if (request.mode === "custom") {
      if (
        typeof request.executable !== "string" ||
        !request.executable.trim()
      ) {
        throw new TypeError("A custom language server executable is required.");
      }
      executable = path.resolve(request.executable.trim());
      if (
        !path.isAbsolute(request.executable.trim()) ||
        !isExecutable(executable)
      ) {
        throw new TypeError(
          "The custom language server executable is not an executable file.",
        );
      }
    }
    this.settings.languages[language] = {
      mode: request.mode as LanguageServerMode,
      executable,
    };
    writeSettings(this.settingsPath, this.settings);
    this.errors.delete(language);
    await this.stopLanguage(language);
    return this.getStatuses();
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown }} value
   */
  async updateDocument(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
  }) {
    const result = await this.synchronizeDocument(
      requireDocumentUpdate(value, this.definitions),
    );
    return {
      active: result.active,
      version: result.version,
      status: result.status,
    };
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, position: unknown }} value
   */
  async getCompletions(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    position: unknown;
  }) {
    const request = requireDocumentFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client) {
      return { isIncomplete: false, items: [] };
    }
    return normalizeCompletionResult(
      await synchronized.client.completion(synchronized.uri, request.position),
    );
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, position: unknown }} value
   */
  async getHover(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    position: unknown;
  }) {
    const request = requireDocumentFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client)
      return { contents: [], range: null };
    return normalizeHoverResult(
      await synchronized.client.hover(synchronized.uri, request.position),
    );
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, position: unknown }} value
   */
  async getDefinitions(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    position: unknown;
  }) {
    const request = requireDocumentFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client) return { locations: [] };
    return normalizeDefinitionResult(
      await synchronized.client.definition(synchronized.uri, request.position),
      this.workspaceRoot,
    );
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, position: unknown }} value
   */
  async getReferences(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    position: unknown;
  }) {
    const request = requireDocumentFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client) return { locations: [] };
    return normalizeDefinitionResult(
      await synchronized.client.references(synchronized.uri, request.position),
      this.workspaceRoot,
    );
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, position: unknown }} value
   */
  async getSignatureHelp(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    position: unknown;
  }) {
    const request = requireDocumentFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client) {
      return { signatures: [], activeSignature: null, activeParameter: null };
    }
    return normalizeSignatureHelpResult(
      await synchronized.client.signatureHelp(
        synchronized.uri,
        request.position,
      ),
    );
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, position: unknown }} value
   */
  async prepareRename(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    position: unknown;
  }) {
    const request = requireDocumentFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client) {
      return { available: false, range: null, placeholder: null };
    }
    try {
      return normalizePrepareRenameResult(
        await synchronized.client.prepareRename(
          synchronized.uri,
          request.position,
        ),
      );
    } catch {
      return { available: false, range: null, placeholder: null };
    }
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, position: unknown, newName: unknown }} value
   */
  async renameSymbol(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    position: unknown;
    newName: unknown;
  }) {
    const request = requireRenameFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client) {
      return {
        edit: null,
        failureReason: "The language server is unavailable.",
      };
    }
    return normalizeRenameResult(
      await synchronized.client.rename(
        synchronized.uri,
        request.position,
        request.newName,
      ),
      this.workspaceRoot,
    );
  }

  /**
   * @param {{ language: unknown, path: unknown, content: unknown, version: unknown, range: unknown, diagnostics: unknown }} value
   */
  async getCodeActions(value: {
    language: unknown;
    path: unknown;
    content: unknown;
    version: unknown;
    range: unknown;
    diagnostics: unknown;
  }) {
    const request = requireCodeActionFeature(value, this.definitions);
    const synchronized = await this.synchronizeDocument(request);
    if (!synchronized.active || !synchronized.client) return { actions: [] };
    const result = await synchronized.client.codeActions(
      synchronized.uri,
      request.range,
      request.diagnostics,
    );
    return await normalizeCodeActionResult(
      result,
      this.workspaceRoot,
      synchronized.client,
    );
  }

  /** @param {{ language: unknown, path: unknown }} value */
  async closeDocument(value: { language: unknown; path: unknown }) {
    const request = recordValue(value);
    if (!request)
      throw new TypeError("Language server close request must be an object.");
    const language = requireLanguage(request.language, this.definitions);
    const relativePath = requireRelativePath(request.path);
    const uri = pathToFileURL(
      resolveDocumentPath(this.workspaceRoot, relativePath),
    ).href;
    await Promise.all(
      [...this.clients.entries()]
        .filter(
          ([key, client]) =>
            key.startsWith(`${language}\0`) && client.hasDocument(uri),
        )
        .map(([, client]) => client.closeDocument(uri)),
    );
  }

  async stop() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.stop()));
  }

  /** @param {string} language */
  async stopLanguage(language: string) {
    const clients = [];
    for (const [key, client] of this.clients) {
      if (!key.startsWith(`${language}\0`)) continue;
      this.clients.delete(key);
      clients.push(client);
    }
    await Promise.allSettled(clients.map((client) => client.stop()));
  }

  async synchronizeDocument(request: DocumentUpdate) {
    const { language, relativePath } = request;
    const definition = requireDefinition(this.definitions, language);
    const absolutePath = resolveDocumentPath(this.workspaceRoot, relativePath);
    const uri = pathToFileURL(absolutePath).href;
    const projectRoot = projectRootFor(
      this.workspaceRoot,
      absolutePath,
      definition.rootMarkers,
    );
    const command = this.resolveCommand(language, projectRoot);
    const status = this.statusFor(language, projectRoot, command);
    if (!command || status.state === "disabled" || status.state === "missing") {
      return {
        active: false,
        version: request.version,
        status,
        client: null,
        uri,
      };
    }

    const key = `${language}\0${projectRoot}`;
    let client = this.clients.get(key);
    try {
      if (!client) {
        client = this.createClient(language, projectRoot, command);
        this.clients.set(key, client);
      }
      this.errors.delete(language);
      await client.updateDocument({
        uri,
        languageId: definition.languageId(relativePath),
        version: request.version,
        content: request.content,
      });
      return {
        active: true,
        version: request.version,
        status: this.statusFor(language, projectRoot),
        client,
        uri,
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.errors.set(language, failure.message);
      if (this.clients.get(key) === client) this.clients.delete(key);
      if (client) void client.stop();
      return {
        active: false,
        version: request.version,
        status: this.statusFor(language, projectRoot),
        client: null,
        uri,
      };
    }
  }

  resolveCommand(
    language: string,
    projectRoot: string,
  ): ResolvedCommand | null {
    const definition = requireDefinition(this.definitions, language);
    const setting = requireSetting(this.settings, language);
    if (setting.mode === "disabled") return null;
    if (setting.mode === "custom") {
      if (!setting.executable || !isExecutable(setting.executable)) return null;
      return {
        executable: setting.executable,
        args: [...definition.args],
        environment: {},
        displayPath: setting.executable,
      };
    }
    const executable = findExecutable(
      definition.command,
      this.workspaceRoot,
      projectRoot,
      this.homeDirectory,
      this.environment,
    );
    if (executable) {
      return resolveNodeScriptCommand(executable, definition.args) ?? {
        executable,
        args: [...definition.args],
        environment: {},
        displayPath: executable,
      };
    }
    return normalizeBundledCommand(this.bundledCommands[language]);
  }

  statusFor(
    language: string,
    projectRoot: string,
    command = this.resolveCommand(language, projectRoot),
  ) {
    const definition = requireDefinition(this.definitions, language);
    const setting = requireSetting(this.settings, language);
    if (setting.mode === "disabled") {
      return {
        language,
        displayName: definition.displayName,
        serverName: definition.serverName,
        mode: setting.mode,
        state: "disabled",
        executable: null,
        message: "Language server disabled; using the built-in parser.",
      };
    }
    if (!command) {
      return {
        language,
        displayName: definition.displayName,
        serverName: definition.serverName,
        mode: setting.mode,
        state: "missing",
        executable: setting.mode === "custom" ? setting.executable : null,
        message: `${definition.serverName} was not found; using the built-in parser.`,
      };
    }
    const failure = this.errors.get(language);
    if (failure) {
      return {
        language,
        displayName: definition.displayName,
        serverName: definition.serverName,
        mode: setting.mode,
        state: "error",
        executable: command.displayPath,
        message: failure,
      };
    }
    const running = [...this.clients.entries()].some(
      ([key, client]) => key.startsWith(`${language}\0`) && client.pid !== null,
    );
    return {
      language,
      displayName: definition.displayName,
      serverName: definition.serverName,
      mode: setting.mode,
      state: running ? "running" : "available",
      executable: command.displayPath,
      message: running
        ? `${definition.serverName} is running.`
        : `${definition.serverName} is available.`,
    };
  }

  createClient(
    language: string,
    projectRoot: string,
    command: ResolvedCommand,
  ) {
    const client = new LanguageServerClient({
      command,
      rootDirectory: projectRoot,
      clientInfo: this.clientInfo,
      ...(this.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.requestTimeoutMs }),
    });
    client.onDiagnostics(({ uri, version, diagnostics }) => {
      let absolutePath;
      try {
        absolutePath = fileURLToPath(uri);
      } catch {
        return;
      }
      if (!isInsideWorkspace(this.workspaceRoot, absolutePath)) return;
      const relativePath = path
        .relative(this.workspaceRoot, absolutePath)
        .split(path.sep)
        .join("/");
      for (const listener of this.diagnosticsListeners) {
        listener({ language, path: relativePath, version, diagnostics });
      }
    });
    client.onDidFail((error) => {
      this.errors.set(language, error.message);
      for (const [key, activeClient] of this.clients) {
        if (activeClient === client) this.clients.delete(key);
      }
    });
    return client;
  }
}
