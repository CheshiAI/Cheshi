import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEGRAPH_DATA_ROOT_ENV = 'CODEGRAPH_DATA_ROOT' as const;

const CHESHI_USER_DATA_DIRECTORY_ENV = 'CHESHI_USER_DATA_DIR';
const WORKSPACE_REGISTRY_VERSION = 1;
const WORKSPACES_DIRECTORY_NAME = 'workspaces';
const CODEGRAPH_DIRECTORY_NAME = 'codegraph';
const WORKSPACE_METADATA_FILE_NAME = 'workspace.json';
const WORKSPACE_REGISTRY_FILE_NAME = 'workspaces.json';

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly storagePath: string;
  readonly codeGraphPath: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
  readonly [key: string]: unknown;
}

export interface WorkspaceRegistry {
  readonly version: 1;
  readonly currentWorkspaceId: string | null;
  readonly workspaces: WorkspaceRecord[];
  readonly [key: string]: unknown;
}

export interface ApplicationDataDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export interface RegisterWorkspaceOptions {
  readonly setCurrent?: boolean;
  readonly timestamp?: Date | string;
}

function requireAbsolutePath(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must be a non-empty absolute path.`);
  }
  const candidate = value.trim();
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path: ${candidate}`);
  }
  return path.resolve(candidate);
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const resolvedRoot = requireAbsolutePath(path.resolve(workspaceRoot), 'Workspace root');
  try {
    return realpathSync.native(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}

function workspaceHashInput(workspaceRoot: string): string {
  const normalizedRoot = canonicalWorkspaceRoot(workspaceRoot).normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
}

function workspaceSlug(workspaceRoot: string): string {
  const baseName = path.basename(canonicalWorkspaceRoot(workspaceRoot)).normalize('NFKD').toLowerCase();
  const slug = baseName
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  return slug || 'workspace';
}

function workspaceStorageId(workspaceRoot: string): string {
  const digest = createHash('sha256').update(workspaceHashInput(workspaceRoot)).digest('hex').slice(0, 24);
  return `${workspaceSlug(workspaceRoot)}-${digest}`;
}

export function resolveCodeGraphDataRoot(environment: NodeJS.ProcessEnv = process.env): string | null {
  const configuredRoot = environment[CODEGRAPH_DATA_ROOT_ENV]?.trim();
  if (!configuredRoot) return null;
  return requireAbsolutePath(configuredRoot, CODEGRAPH_DATA_ROOT_ENV);
}

function workspaceStorageDirectory(dataRoot: string, workspaceRoot: string): string {
  const resolvedDataRoot = requireAbsolutePath(dataRoot, 'Cheshi data root');
  return path.join(resolvedDataRoot, WORKSPACES_DIRECTORY_NAME, workspaceStorageId(workspaceRoot));
}

export function codeGraphStorageDirectory(dataRoot: string, workspaceRoot: string): string {
  return path.join(workspaceStorageDirectory(dataRoot, workspaceRoot), CODEGRAPH_DIRECTORY_NAME);
}

export function defaultApplicationDataDirectory(
  dataDirectory: string,
  options: ApplicationDataDirectoryOptions = {},
): string {
  if (!dataDirectory.trim()) {
    throw new Error('Application data directory name must not be empty.');
  }
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  let applicationDataRoot: string;

  if (platform === 'darwin') {
    applicationDataRoot = path.join(homeDirectory, 'Library', 'Application Support');
  } else if (platform === 'win32') {
    applicationDataRoot = environment.APPDATA?.trim() || path.join(homeDirectory, 'AppData', 'Roaming');
  } else {
    applicationDataRoot = environment.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, '.config');
  }

  return path.join(path.resolve(applicationDataRoot), dataDirectory.trim());
}

export function resolveCheshiUserDataDirectory(
  dataDirectory: string,
  options: ApplicationDataDirectoryOptions = {},
): string {
  const environment = options.environment ?? process.env;
  const configuredDirectory = environment[CHESHI_USER_DATA_DIRECTORY_ENV]?.trim();
  if (configuredDirectory) {
    return requireAbsolutePath(configuredDirectory, CHESHI_USER_DATA_DIRECTORY_ENV);
  }
  return defaultApplicationDataDirectory(dataDirectory, options);
}

function workspaceRegistryPath(dataRoot: string): string {
  return path.join(requireAbsolutePath(dataRoot, 'Cheshi data root'), WORKSPACE_REGISTRY_FILE_NAME);
}

function emptyWorkspaceRegistry(): WorkspaceRegistry {
  return {
    version: WORKSPACE_REGISTRY_VERSION,
    currentWorkspaceId: null,
    workspaces: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWorkspaceRecord(value: unknown, registryPath: string): asserts value is WorkspaceRecord {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.rootPath !== 'string'
    || typeof value.storagePath !== 'string'
    || typeof value.codeGraphPath !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.lastOpenedAt !== 'string'
  ) {
    throw new Error(`Invalid workspace record in ${registryPath}.`);
  }
}

function assertWorkspaceRegistry(value: unknown, registryPath: string): asserts value is WorkspaceRegistry {
  if (
    !isRecord(value)
    || value.version !== WORKSPACE_REGISTRY_VERSION
    || !Array.isArray(value.workspaces)
    || !(value.currentWorkspaceId === null || typeof value.currentWorkspaceId === 'string')
  ) {
    throw new Error(`Unsupported or invalid workspace registry: ${registryPath}`);
  }
  for (const workspace of value.workspaces) assertWorkspaceRecord(workspace, registryPath);
}

export function readWorkspaceRegistry(dataRoot: string): WorkspaceRegistry {
  const registryPath = workspaceRegistryPath(dataRoot);
  if (!existsSync(registryPath)) return emptyWorkspaceRegistry();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read workspace registry ${registryPath}: ${reason}`);
  }

  assertWorkspaceRegistry(parsed, registryPath);
  return parsed;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // File modes are not available on every supported filesystem.
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function registerWorkspace(
  dataRoot: string,
  workspaceRoot: string,
  options: RegisterWorkspaceOptions = {},
): WorkspaceRecord {
  const resolvedDataRoot = requireAbsolutePath(dataRoot, 'Cheshi data root');
  const rootPath = canonicalWorkspaceRoot(workspaceRoot);
  const id = workspaceStorageId(rootPath);
  const storagePath = workspaceStorageDirectory(resolvedDataRoot, rootPath);
  const codeGraphPath = codeGraphStorageDirectory(resolvedDataRoot, rootPath);
  const timestamp = options.timestamp instanceof Date
    ? options.timestamp.toISOString()
    : typeof options.timestamp === 'string'
      ? new Date(options.timestamp).toISOString()
      : new Date().toISOString();
  const registry = readWorkspaceRegistry(resolvedDataRoot);
  const existingWorkspace = registry.workspaces.find((workspace) => workspace.id === id);
  const workspace: WorkspaceRecord = {
    ...existingWorkspace,
    id,
    name: path.basename(rootPath) || 'Workspace',
    rootPath,
    storagePath,
    codeGraphPath,
    createdAt: existingWorkspace?.createdAt ?? timestamp,
    lastOpenedAt: timestamp,
  };
  const workspaces = registry.workspaces
    .filter((entry) => entry.id !== id)
    .concat(workspace)
    .sort((left, right) => left.name.localeCompare(right.name) || left.rootPath.localeCompare(right.rootPath));
  const nextRegistry: WorkspaceRegistry = {
    ...registry,
    version: WORKSPACE_REGISTRY_VERSION,
    currentWorkspaceId: options.setCurrent === true ? id : registry.currentWorkspaceId,
    workspaces,
  };

  mkdirSync(storagePath, { recursive: true });
  writeJsonAtomically(path.join(storagePath, WORKSPACE_METADATA_FILE_NAME), workspace);
  writeJsonAtomically(workspaceRegistryPath(resolvedDataRoot), nextRegistry);
  return workspace;
}

export function unregisterWorkspace(
  dataRoot: string,
  workspace: Pick<WorkspaceRecord, 'id' | 'rootPath'>,
): boolean {
  const registry = readWorkspaceRegistry(dataRoot);
  const matches = registry.workspaces.filter((entry) => entry.id === workspace.id);
  if (matches.length === 0) return false;
  if (matches.length !== 1 || matches[0]?.rootPath !== workspace.rootPath) {
    throw new Error('The registered workspace changed. Refresh the workspace list and try again.');
  }
  writeJsonAtomically(workspaceRegistryPath(dataRoot), {
    ...registry,
    currentWorkspaceId: registry.currentWorkspaceId === workspace.id ? null : registry.currentWorkspaceId,
    workspaces: registry.workspaces.filter((entry) => entry.id !== workspace.id),
  });
  return true;
}
