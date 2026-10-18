import { parseAgentPackage, type AgentPackage } from './agent-package.ts';

export interface HomieRepositoryConnection { repository: string; hash: string }
export interface HomieRepositoryPreview extends HomieRepositoryConnection { directory: string; definition: AgentPackage }

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
  return { repository: parseHomieRepository(input.repository), hash: input.hash };
}
export function parseHomieRepositoryPreview(value: unknown): HomieRepositoryPreview {
  const input = value as Partial<HomieRepositoryPreview> | null;
  const connection = parseHomieRepositoryConnection(input);
  if (typeof input?.directory !== 'string' || !input.directory.startsWith('/') || input.directory.includes('\0')) throw new TypeError('Invalid repository directory.');
  return { ...connection, directory: input.directory, definition: parseAgentPackage(input.definition) };
}
