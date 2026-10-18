import { parseAgentPackage, type AgentPackage } from './agent-package.ts';

export interface HomieRepositoryDestination { repository: string; directory?: string }
export interface HomieRepositoryLocationRequest extends HomieRepositoryDestination { choose?: boolean }
export interface HomieRepositoryConnection { repository: string; directory: string; hash: string }
export interface HomieRepositoryPreview extends HomieRepositoryConnection { definition: AgentPackage }

export function parseHomieRepository(value: unknown): string {
  if (typeof value !== 'string' || value.length > 250) throw new TypeError('Enter a GitHub repository URL or owner/name.');
  const name = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(name) || ['.', '..'].includes(name.split('/')[1]!)) {
    throw new TypeError('Enter a GitHub repository URL or owner/name.');
  }
  return name;
}
export function parseHomieRepositoryConnection(value: unknown): HomieRepositoryConnection {
  const input = value as Partial<HomieRepositoryConnection> | null;
  if (!input || typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash)) throw new TypeError('Check the repository before connecting it.');
  return { repository: parseHomieRepository(input.repository), directory: parseHomieRepositoryDirectory(input.directory), hash: input.hash };
}
export function parseHomieRepositoryDirectory(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || /[\0\r\n]/.test(value)
    || value.split('/').includes('..') || value.split('/').every(part => !part || part === '.')) {
    throw new TypeError('Choose an absolute repository folder, not the filesystem root.');
  }
  return value;
}
export function parseHomieRepositoryDestination(value: unknown): HomieRepositoryDestination {
  const input = value as Partial<HomieRepositoryDestination> | null;
  return { repository: parseHomieRepository(input?.repository),
    ...(input?.directory === undefined ? {} : { directory: parseHomieRepositoryDirectory(input.directory) }) };
}
export function parseHomieRepositoryLocationRequest(value: unknown): HomieRepositoryLocationRequest {
  const input = value as Partial<HomieRepositoryLocationRequest> | null;
  if (input?.choose !== undefined && typeof input.choose !== 'boolean') throw new TypeError('Invalid folder selection request.');
  return { ...parseHomieRepositoryDestination(value), choose: input?.choose === true };
}
export function parseHomieRepositoryPreview(value: unknown): HomieRepositoryPreview {
  const input = value as Partial<HomieRepositoryPreview> | null;
  const connection = parseHomieRepositoryConnection(input);
  return { ...connection, definition: parseAgentPackage(input?.definition) };
}
