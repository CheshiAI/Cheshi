type JsonObject = Record<string, unknown>;

/**
 * @param {string} event
 * @param {JsonObject} details
 */
export function noopLog(event: string, details: JsonObject) {
  void event;
  void details;
}

/**
 * @param {unknown} value
 * @returns {JsonObject | null}
 */
export function recordValue(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as JsonObject;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
