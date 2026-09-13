import type { AppRelease } from '../shared/app-update.ts';
export type { AppRelease } from '../shared/app-update.ts';

const RELEASES_API = 'https://api.github.com/repos/CheshiAI/Cheshi/releases';
const RELEASES_PATH = '/CheshiAI/Cheshi/releases/';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const MAX_NOTES_LENGTH = 16_000;

interface ReleaseVersion {
  version: string;
  core: string[];
  prerelease: string[];
}

function parseVersion(input: string): ReleaseVersion {
  const match = input.length <= 256 && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(input);
  if (!match) throw new Error(`Invalid release version: ${input.slice(0, 256)}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) throw new Error('Invalid numeric prerelease identifier.');
  return { version: input.replace(/^v/, ''), core: match.slice(1, 4), prerelease };
}

function compareNumericIdentifiers(left: string, right: string): number {
  return left.length === right.length ? (left === right ? 0 : left < right ? -1 : 1) : left.length < right.length ? -1 : 1;
}

/** SemVer precedence, including numeric prerelease identifiers and ignored build metadata. */
export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    const result = compareNumericIdentifiers(a.core[index]!, b.core[index]!);
    if (result !== 0) return result;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const first = a.prerelease[index];
    const second = b.prerelease[index];
    if (first === undefined || second === undefined) return first === undefined ? -1 : 1;
    if (first === second) continue;
    const firstNumeric = /^\d+$/.test(first);
    const secondNumeric = /^\d+$/.test(second);
    if (firstNumeric && secondNumeric) return compareNumericIdentifiers(first, second);
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    return first < second ? -1 : 1;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed GitHub release response.');
  return value as Record<string, unknown>;
}

function trustedReleaseUrl(value: unknown, suffix: string): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === 'https:' && url.hostname === 'github.com' && url.port === ''
    && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
    && url.pathname === `${RELEASES_PATH}${suffix}` ? url.href : null;
}

function selectAsset(assets: unknown[], version: ReleaseVersion, tag: string, platform: string, arch: string): AppRelease['asset'] {
  const names = new Set([
    `Cheshi-${version.version}-${platform}-${arch}.zip`,
    `Cheshi-${platform}-${arch}-${version.version}.zip`,
  ].map((name) => name.toLowerCase()));
  for (const value of assets) {
    const asset = record(value);
    if (typeof asset.name !== 'string' || !names.has(asset.name.toLowerCase())) continue;
    const url = trustedReleaseUrl(asset.browser_download_url, `download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`);
    if (!url || typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)
      || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
    return { name: asset.name, url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
  }
  return null;
}

function parseRelease(value: unknown, current: ReleaseVersion, platform: string, arch: string): AppRelease | null {
  const release = record(value);
  if (typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('Malformed GitHub release flags.');
  if (release.draft === true) return null;
  if (typeof release.tag_name !== 'string') throw new Error('Malformed GitHub release tag.');
  let version: ReleaseVersion;
  try { version = parseVersion(release.tag_name); } catch { return null; }
  const channel = version.prerelease[0];
  const currentChannel = current.prerelease[0];
  if (channel !== undefined && channel !== 'alpha' && channel !== 'preview') return null;
  if (currentChannel === undefined && (channel !== undefined || release.prerelease === true)) return null;
  if (currentChannel === 'preview' && channel === 'alpha') return null;
  if (compareReleaseVersions(version.version, current.version) <= 0) return null;
  const url = trustedReleaseUrl(release.html_url, `tag/${encodeURIComponent(release.tag_name)}`);
  if (!url || !Array.isArray(release.assets) || !(release.body === null || typeof release.body === 'string')) {
    throw new Error('Malformed GitHub release details.');
  }
  return {
    version: version.version,
    tag: release.tag_name,
    url,
    notes: (release.body ?? '').slice(0, MAX_NOTES_LENGTH),
    asset: selectAsset(release.assets, version, release.tag_name, platform, arch),
  };
}

function hasNextPage(response: Response, page: number): boolean {
  const link = response.headers.get('link');
  if (!link) return false;
  for (const entry of link.split(',')) {
    if (!/;\s*rel="next"/.test(entry)) continue;
    const match = /^\s*<([^>]+)>/.exec(entry);
    if (!match) throw new Error('Malformed GitHub release pagination.');
    const url = new URL(match[1]!);
    if (url.origin !== 'https://api.github.com' || url.username || url.password
      || url.pathname !== '/repos/CheshiAI/Cheshi/releases' || url.hash
      || url.searchParams.get('page') !== String(page + 1) || url.searchParams.get('per_page') !== '100') {
      throw new Error('Unexpected GitHub release pagination.');
    }
    return true;
  }
  return false;
}

export async function findAppRelease(options: {
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<AppRelease | null> {
  const current = parseVersion(options.currentVersion);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const timer = setTimeout(() => controller.abort(new Error('GitHub release check timed out.')), REQUEST_TIMEOUT_MS);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const fetchRelease = options.fetch ?? globalThis.fetch;
  const scan = async (): Promise<AppRelease | null> => {
    controller.signal.throwIfAborted();
    let latest: AppRelease | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetchRelease(`${RELEASES_API}?per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Cheshi' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 404 && page === 1) return null;
      if (!response.ok) throw new Error(`GitHub release check failed (${response.status}).`);
      const data: unknown = await response.json();
      controller.signal.throwIfAborted();
      if (!Array.isArray(data) || data.length > 100) throw new Error('Malformed GitHub release list.');
      for (const value of data) {
        const release = parseRelease(value, current, options.platform, options.arch);
        if (release && (!latest || compareReleaseVersions(release.version, latest.version) > 0)) latest = release;
      }
      if (!hasNextPage(response, page)) return latest;
    }
    throw new Error('GitHub release pagination limit reached.');
  };
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason ?? new Error('GitHub release check cancelled.'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try { return await Promise.race([scan(), cancelled]); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}
