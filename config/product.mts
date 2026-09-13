import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProductMetadata {
  readonly displayName: string;
  readonly version: string;
  readonly buildNumber: string;
  readonly internalName: string;
  readonly bundleId: string;
  readonly dataDirectory: string;
  readonly publisher: string;
}

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvironment(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Invalid product metadata line: ${rawLine}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

const productFile = path.resolve(
  process.env.CHESHI_PRODUCT_FILE?.trim() || path.join(rootDirectory, '.env.product'),
);
const fileValues = parseEnvironment(readFileSync(productFile, 'utf8'));

function valueFor(key: string): string {
  return process.env[key]?.trim() || fileValues.get(key)?.trim() || '';
}

function required(key: string): string {
  const value = valueFor(key);
  if (!value) throw new Error(`Missing ${key} in ${productFile}`);
  return value;
}

function assertPattern(key: string, value: string, pattern: RegExp, description: string): void {
  if (!pattern.test(value)) throw new Error(`${key} must be ${description}: ${value}`);
}

const displayName = required('APP_DISPLAY_NAME');
const version = required('APP_VERSION');
const buildNumber = required('APP_BUILD_NUMBER');
const internalName = required('APP_INTERNAL_NAME');
const bundleId = required('APP_BUNDLE_ID');
const dataDirectory = required('APP_DATA_DIRECTORY');
const publisher = required('APP_PUBLISHER');

assertPattern('APP_VERSION', version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u, 'a semantic version');
assertPattern('APP_BUILD_NUMBER', buildNumber, /^\d+$/u, 'a positive integer');
assertPattern('APP_INTERNAL_NAME', internalName, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'a lowercase slug');
assertPattern('APP_BUNDLE_ID', bundleId, /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u, 'a reverse-DNS identifier');
assertPattern('APP_DATA_DIRECTORY', dataDirectory, /^[A-Za-z0-9._-]+$/u, 'a stable directory name');

export const product: Readonly<ProductMetadata> = Object.freeze({
  displayName,
  version,
  buildNumber,
  internalName,
  bundleId,
  dataDirectory,
  publisher,
});
