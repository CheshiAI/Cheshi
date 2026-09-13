import {
  finiteNumber,
  noopLog,
  recordValue,
  stringValue,
} from "./codex-service-utils.mts";

const ACCOUNT_NOTIFICATION_METHODS = new Set([
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
]);

type JsonObject = Record<string, unknown>;
interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
interface CodexRateLimit {
  limitId: string;
  limitName: string | null;
  plan: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}
type CodexAccountState =
  "stopped" | "starting" | "login_required" | "ready" | "error";
interface CodexAccountStatus {
  state: CodexAccountState;
  authenticated: boolean;
  plan: string | null;
  rateLimits: CodexRateLimit[];
  error: string | null;
}
interface CodexAccountClient {
  start: () => Promise<unknown>;
  request: (method: string, params?: unknown) => Promise<unknown>;
  stop: () => Promise<void>;
  onNotification: (listener: (value: JsonObject) => void) => () => void;
  onDidFail: (listener: (error: Error) => void) => () => void;
}
type CodexAccountLogger = (event: string, details: JsonObject) => void;

/**
 * @param {unknown} value
 * @returns {CodexRateLimitWindow | null}
 */
function normalizeRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  const record = recordValue(value);
  const usedPercent = finiteNumber(record?.usedPercent);
  if (!record || usedPercent === null) return null;
  const windowDurationMins = finiteNumber(record.windowDurationMins);
  const resetsAt = finiteNumber(record.resetsAt);
  return {
    usedPercent,
    windowDurationMins:
      windowDurationMins !== null && windowDurationMins >= 0
        ? windowDurationMins
        : null,
    resetsAt: resetsAt !== null && resetsAt >= 0 ? resetsAt : null,
  };
}

/**
 * @param {unknown} value
 * @param {string} fallbackLimitId
 * @returns {CodexRateLimit | null}
 */
function normalizeRateLimit(
  value: unknown,
  fallbackLimitId: string,
): CodexRateLimit | null {
  const record = recordValue(value);
  if (!record) return null;
  const primary = normalizeRateLimitWindow(record.primary);
  const secondary = normalizeRateLimitWindow(record.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: stringValue(record.limitId) ?? fallbackLimitId,
    limitName: stringValue(record.limitName),
    plan: stringValue(record.planType) ?? stringValue(record.plan),
    primary,
    secondary,
  };
}

/**
 * @param {unknown} value
 * @returns {CodexRateLimit[]}
 */
export function normalizeRateLimits(value: unknown): CodexRateLimit[] {
  const record = recordValue(value);
  const limitsById = recordValue(record?.rateLimitsByLimitId);
  const limits = limitsById
    ? Object.entries(limitsById).flatMap(([limitId, limitValue]) => {
        const limit = normalizeRateLimit(limitValue, limitId);
        return limit ? [limit] : [];
      })
    : [];
  if (limits.length > 0) return limits;
  const fallback = normalizeRateLimit(record?.rateLimits, "codex");
  return fallback ? [fallback] : [];
}

/**
 * @param {unknown} value
 * @returns {JsonObject | null}
 */
function accountValue(value: unknown): JsonObject | null {
  const record = recordValue(value);
  const account = recordValue(record?.account);
  if (!account) return null;
  const type = stringValue(account.type)?.toLowerCase();
  const hasChatGptIdentity =
    type === "chatgpt" ||
    stringValue(account.email) !== null ||
    stringValue(account.name) !== null ||
    stringValue(account.planType) !== null;
  return hasChatGptIdentity ? account : null;
}

/** @returns {CodexAccountStatus} */
function emptyStatus(): CodexAccountStatus {
  return {
    state: "stopped",
    authenticated: false,
    plan: null,
    rateLimits: [],
    error: null,
  };
}

/**
 * @param {CodexRateLimitWindow | null} window
 * @returns {CodexRateLimitWindow | null}
 */
function snapshotRateLimitWindow(
  window: CodexRateLimitWindow | null,
): CodexRateLimitWindow | null {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
  };
}

/**
 * @param {CodexRateLimit} limit
 * @returns {CodexRateLimit}
 */
function snapshotRateLimit(limit: CodexRateLimit): CodexRateLimit {
  return {
    limitId: limit.limitId,
    limitName: limit.limitName,
    plan: limit.plan,
    primary: snapshotRateLimitWindow(limit.primary),
    secondary: snapshotRateLimitWindow(limit.secondary),
  };
}

/**
 * @param {CodexAccountStatus} status
 * @returns {CodexAccountStatus}
 */
function snapshotStatus(status: CodexAccountStatus): CodexAccountStatus {
  return {
    state: status.state,
    authenticated: status.authenticated,
    plan: status.plan,
    rateLimits: status.rateLimits.map(snapshotRateLimit),
    error: status.error,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found|could not be found/iu.test(message)) {
    return "Codex CLI was not found. Check the CHESHI_CODEX path.";
  }
  if (/timed out/iu.test(message))
    return "The Codex account information request timed out.";
  return "Unable to load Codex account information.";
}

function safeUsageErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|unauthorized/iu.test(message)) {
    return "Usage authentication failed (401). Log out of this account and sign in again.";
  }
  if (/timed? out|timeout/iu.test(message)) return "The usage request timed out. Refresh to try again.";
  return "Unable to load account usage. Refresh to try again.";
}

export class CodexAccountService {
  private stopped = false;
  private generation = 0;
  removeFailureListener: () => void;
  removeNotificationListener: () => void;
  started: boolean;
  refreshPromise: Promise<void> | null;
  startPromise: Promise<void> | null;
  listeners: Set<(status: CodexAccountStatus) => void>;
  status: CodexAccountStatus;
  log: CodexAccountLogger;
  client: CodexAccountClient;
  /**
   * @param {{ client: CodexAccountClient, log?: CodexAccountLogger }} options
   */
  constructor({
    client,
    log = noopLog,
  }: {
    client: CodexAccountClient;
    log?: CodexAccountLogger;
  }) {
    this.client = client;
    this.log = log;
    /** @type {CodexAccountStatus} */
    this.status = emptyStatus();
    /** @type {Set<(status: CodexAccountStatus) => void>} */
    this.listeners = new Set();
    /** @type {Promise<void> | null} */
    this.startPromise = null;
    /** @type {Promise<void> | null} */
    this.refreshPromise = null;
    this.started = false;
    this.removeNotificationListener = client.onNotification((value) =>
      this.handleNotification(value),
    );
    this.removeFailureListener = client.onDidFail((error) =>
      this.handleFailure(error),
    );
  }

  /**
   * @param {(status: CodexAccountStatus) => void} listener
   * @returns {() => void}
   */
  onDidChange(listener: (status: CodexAccountStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** @returns {Promise<CodexAccountStatus>} */
  async getStatus(): Promise<CodexAccountStatus> {
    const generation = this.generation;
    try {
      await this.start();
      if (!this.isCurrent(generation)) return snapshotStatus(this.status);
      await this.refresh();
    } catch (error) {
      if (this.isCurrent(generation) && this.status.state !== "error") this.handleFailure(error);
    }
    return snapshotStatus(this.status);
  }

  /** @returns {Promise<void>} */
  async start(): Promise<void> {
    if (this.stopped) {
      this.stopped = false;
      this.removeNotificationListener = this.client.onNotification((value) => this.handleNotification(value));
      this.removeFailureListener = this.client.onDidFail((error) => this.handleFailure(error));
    }
    if (this.started) return;
    if (this.startPromise) return await this.startPromise;
    const operation = this.startInternal();
    this.startPromise = operation;
    try {
      await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = null;
    }
  }

  /** @returns {Promise<void>} */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshPromise) return await this.refreshPromise;
    const operation = this.refreshInternal();
    this.refreshPromise = operation;
    try {
      await operation;
    } finally {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    }
  }

  /** @returns {Promise<void>} */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.started = false;
    this.startPromise = null;
    this.refreshPromise = null;
    this.status = emptyStatus();
    this.removeNotificationListener();
    this.removeFailureListener();
    await this.client.stop();
  }

  /** @returns {Promise<void>} */
  async startInternal(): Promise<void> {
    const generation = this.generation;
    this.status = { ...emptyStatus(), state: "starting" };
    this.emit();
    await this.client.start();
    if (!this.isCurrent(generation)) return;
    this.started = true;
  }

  /** @returns {Promise<void>} */
  async refreshInternal(): Promise<void> {
    const generation = this.generation;
    const rawAccount = await this.client.request("account/read", {
      refreshToken: false,
    });
    if (!this.isCurrent(generation)) return;
    const account = accountValue(rawAccount);
    if (!account) {
      this.status = {
        ...emptyStatus(),
        state: "login_required",
      };
      this.emit();
      return;
    }

    /** @type {CodexRateLimit[]} */
    let rateLimits: CodexRateLimit[] = [];
    let usageError: string | null = null;
    try {
      rateLimits = normalizeRateLimits(
        await this.client.request("account/rateLimits/read"),
      );
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      usageError = safeUsageErrorMessage(error);
      this.log("codex-rate-limits-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!this.isCurrent(generation)) return;
    this.status = {
      state: usageError ? "error" : "ready",
      authenticated: true,
      plan:
        stringValue(account.planType) ??
        stringValue(account.plan) ??
        rateLimits.find((limit) => limit.plan)?.plan ??
        null,
      rateLimits,
      error: usageError,
    };
    this.emit();
  }

  /** @param {JsonObject} value */
  handleNotification(value: JsonObject) {
    if (this.stopped) return;
    const generation = this.generation;
    const method = stringValue(recordValue(value)?.method);
    if (!method || !ACCOUNT_NOTIFICATION_METHODS.has(method)) return;
    void this.refresh().catch((error) => {
      if (this.isCurrent(generation) && this.status.state !== "error") this.handleFailure(error);
    });
  }

  /** @param {unknown} error */
  handleFailure(error: unknown) {
    if (this.stopped) return;
    this.started = false;
    this.log("codex-account-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    this.status = {
      ...snapshotStatus(this.status),
      state: "error",
      error: safeErrorMessage(error),
    };
    this.emit();
  }

  emit() {
    const status = snapshotStatus(this.status);
    for (const listener of this.listeners) listener(status);
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }
}
