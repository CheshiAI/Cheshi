interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}
interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

/**
 * Reuses one in-flight asynchronous operation and permits a new operation after
 * the previous one settles.
 *
 * @template T
 */
export class SingleFlight<T> {
  operation: Promise<T> | null;
  constructor() {
    /** @type {Promise<T> | null} */
    this.operation = null;
  }

  /**
   * @param {() => Promise<T>} createOperation
   * @returns {Promise<T>}
   */
  async run(createOperation: () => Promise<T>): Promise<T> {
    if (this.operation) return await this.operation;

    const operation = createOperation();
    this.operation = operation;
    try {
      return await operation;
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }
}

export class JsonRpcRequestTracker {
  pending: Map<number, PendingRequest>;
  nextRequestId: number;
  createTimeoutError: (method: string) => Error;
  /** @param {(method: string) => Error} createTimeoutError */
  constructor(createTimeoutError: (method: string) => Error) {
    this.createTimeoutError = createTimeoutError;
    this.nextRequestId = 1;
    /** @type {Map<number, PendingRequest>} */
    this.pending = new Map();
  }

  /**
   * @param {string} method
   * @param {unknown} params
   * @param {number} timeoutMs
   * @param {(request: JsonRpcRequest) => Promise<void>} sendRequest
   * @returns {Promise<unknown>}
   */
  async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    sendRequest: (request: JsonRpcRequest) => Promise<void>,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    const response = new globalThis.Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(this.createTimeoutError(method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });

    try {
      await sendRequest({
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (error) {
      this.reject(id, error);
    }
    return await response;
  }

  /**
   * @param {number} id
   * @param {unknown} value
   * @returns {boolean}
   */
  resolve(id: number, value: unknown): boolean {
    const pending = this.take(id);
    if (!pending) return false;
    pending.resolve(value);
    return true;
  }

  /**
   * @param {number} id
   * @param {unknown} error
   * @returns {boolean}
   */
  reject(id: number, error: unknown): boolean {
    const pending = this.take(id);
    if (!pending) return false;
    pending.reject(error);
    return true;
  }

  /** @param {unknown} error */
  rejectAll(error: unknown) {
    for (const id of this.pending.keys()) this.reject(id, error);
  }

  /**
   * @param {number} id
   * @returns {PendingRequest | null}
   */
  take(id: number): PendingRequest | null {
    const pending = this.pending.get(id) ?? null;
    if (!pending) return null;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    return pending;
  }
}

export class SerializedProcessWriter {
  observedInputs: WeakSet<object>;
  inputFailures: WeakMap<object, any>;
  writeTail: Promise<void>;
  createUnavailableError: () => Error;
  getInput: () => import("node:stream").Writable | null | undefined;
  /**
   * @param {() => import('node:stream').Writable | null | undefined} getInput
   * @param {() => Error} createUnavailableError
   */
  constructor(
    getInput: () => import("node:stream").Writable | null | undefined,
    createUnavailableError: () => Error,
  ) {
    this.getInput = getInput;
    this.createUnavailableError = createUnavailableError;
    this.writeTail = Promise.resolve();
    /** @type {WeakMap<import('node:stream').Writable, Error>} */
    this.inputFailures = new WeakMap();
    /** @type {WeakSet<import('node:stream').Writable>} */
    this.observedInputs = new WeakSet();
  }

  /** @param {string} payload */
  async write(payload: string) {
    const operation = this.writeTail.then(async () => {
      const input = this.getInput();
      if (!input) throw this.createUnavailableError();
      this.observeInput(input);
      const inputFailure = this.inputFailures.get(input);
      if (inputFailure) throw inputFailure;
      if (!input.writable) throw this.createUnavailableError();
      await new globalThis.Promise<void>((resolve, reject) => {
        try {
          input.write(payload, (error) => {
            if (error) {
              this.inputFailures.set(input, error);
              reject(error);
            } else {
              resolve();
            }
          });
        } catch (error) {
          if (error instanceof Error) this.inputFailures.set(input, error);
          reject(error);
        }
      });
    });
    this.writeTail = operation.catch(() => {});
    await operation;
  }

  /** @param {import('node:stream').Writable} input */
  observeInput(input: import("node:stream").Writable) {
    if (this.observedInputs.has(input)) return;
    this.observedInputs.add(input);
    // Node reports a failed write to its callback before emitting the stream's
    // error event. Observe the input for its lifetime so a shutdown-time EPIPE
    // is retained as a write failure instead of escaping the main process.
    input.on("error", (error) => {
      this.inputFailures.set(input, error);
    });
  }
}
