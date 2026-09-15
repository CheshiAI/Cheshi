import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sourceRepository = 'CheshiAI/Cheshi';
const tapRepository = 'CheshiAI/homebrew-tap';
const caskPath = 'Casks/cheshi.rb';
const tapBranch = 'main';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview((?:\.(?:0|[1-9]\d*))*))?$/;
const caskUrl = 'https://github.com/CheshiAI/Cheshi/releases/download/v#{version}/Cheshi-darwin-arm64-#{version}.zip';

type Request = (url: string, init?: RequestInit) => Promise<Response>;
interface UpdateOptions {
  tag: string;
  sourceToken?: string;
  tapToken?: string;
  dryRun?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a GitHub object.');
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}.`);
  return value;
}

function versionParts(version: string) {
  const match = versionPattern.exec(version);
  if (!match) throw new Error(`Unsupported public version: ${version}`);
  return { core: match.slice(1, 4).map(BigInt), preview: match[4]?.split('.').filter(Boolean).map(BigInt) };
}

export function comparePublicVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const compare = (x: bigint[], y: bigint[]) => {
    for (let index = 0; index < Math.max(x.length, y.length); index++) {
      const first = x[index];
      const second = y[index];
      if (first === second) continue;
      if (first === undefined) return -1;
      if (second === undefined) return 1;
      return first < second ? -1 : 1;
    }
    return 0;
  };
  const core = compare(a.core, b.core);
  if (core) return core;
  if (a.preview === undefined) return b.preview === undefined ? 0 : 1;
  if (b.preview === undefined) return -1;
  return compare(a.preview, b.preview);
}

function caskField(content: string, field: string): { value: string; pattern: RegExp } {
  const pattern = new RegExp(`^(\\s*)${field} "([^"\\r\\n]+)"[ \\t]*$`, 'gm');
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0]?.[2]) throw new Error(`Expected exactly one cask ${field}.`);
  return { value: matches[0][2], pattern };
}

export function prepareCaskUpdate(content: string, version: string, sha256: string): string | null {
  if (!/^cask "cheshi" do\r?$/m.test(content)) throw new Error('Unexpected cask identity.');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA256.');
  const currentVersion = caskField(content, 'version');
  const currentHash = caskField(content, 'sha256');
  const currentUrl = caskField(content, 'url');
  if (currentUrl.value !== caskUrl) throw new Error('Unexpected cask URL template.');
  const comparison = comparePublicVersions(version, currentVersion.value);
  if (comparison < 0) return null;
  if (comparison === 0) {
    if (currentHash.value !== sha256) throw new Error('Published version has a different SHA256; use a new version.');
    return null;
  }
  return content
    .replace(currentVersion.pattern, `$1version "${version}"`)
    .replace(currentHash.pattern, `$1sha256 "${sha256}"`)
    .replace('skip "Preview releases are updated manually"', 'skip "Updated by the Cheshi release workflow"');
}

async function github(request: Request, path: string, token?: string, body?: unknown) {
  const response = await request(`https://api.github.com/repos/${path}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GitHub ${body === undefined ? 'GET' : 'PUT'} ${path}: HTTP ${response.status}`);
  return record(await response.json());
}

async function downloadHash(request: Request, url: string, size: number, digest: string): Promise<string> {
  const response = await request(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Release download failed: HTTP ${response.status}`);
  const hash = createHash('sha256');
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > size) throw new Error('Release asset exceeds its recorded size.');
    hash.update(chunk);
  }
  if (received !== size) throw new Error('Release asset size mismatch.');
  const sha256 = hash.digest('hex');
  if (`sha256:${sha256}` !== digest) throw new Error('Release asset SHA256 mismatch.');
  return sha256;
}

function decodeCask(file: Record<string, unknown>): string {
  if (file.type !== 'file' || file.encoding !== 'base64' || file.path !== caskPath) {
    throw new Error('Unexpected GitHub cask response.');
  }
  return Buffer.from(string(file.content, 'cask content'), 'base64').toString('utf8');
}

export async function updateHomebrewTap(options: UpdateOptions, request: Request = fetch) {
  if (/^v\d+\.\d+\.\d+-alpha(?:\.[0-9]+)*$/.test(options.tag)) return { status: 'skipped-alpha' };
  if (!options.tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const version = options.tag.slice(1);
  versionParts(version);
  if (options.dryRun !== true && !options.tapToken) throw new Error('Configure the HOMEBREW_TAP_TOKEN Actions secret.');
  const release = await github(request, `${sourceRepository}/releases/tags/${encodeURIComponent(options.tag)}`, options.sourceToken);
  if (release.tag_name !== options.tag || release.draft !== false || typeof release.published_at !== 'string') {
    throw new Error('The requested release must be published.');
  }
  const name = `Cheshi-darwin-arm64-${version}.zip`;
  if (!Array.isArray(release.assets)) throw new Error('Missing release assets.');
  const assets = release.assets.map(record).filter(asset => asset.name === name);
  if (assets.length !== 1) throw new Error(`Expected exactly one ${name} asset.`);
  const asset = assets[0]!;
  const url = `https://github.com/${sourceRepository}/releases/download/${options.tag}/${name}`;
  if (asset.browser_download_url !== url || asset.state !== 'uploaded' ||
    typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
    typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('Release asset URL, state, size or digest is invalid.');
  }
  const sha256 = await downloadHash(request, url, asset.size, asset.digest);
  const path = `${tapRepository}/contents/${caskPath}`;
  const file = await github(request, `${path}?ref=${tapBranch}`, options.tapToken);
  const content = prepareCaskUpdate(decodeCask(file), version, sha256);
  if (content === null) return { status: 'unchanged', version, sha256 };
  if (options.dryRun === true) return { status: 'dry-run', version, sha256, content };
  const result = await github(request, path, options.tapToken, {
    branch: tapBranch,
    sha: string(file.sha, 'cask blob SHA'),
    message: `[build] update cheshi to ${version}`,
    content: Buffer.from(content).toString('base64'),
  });
  const commit = record(result.commit);
  const commitSha = string(commit.sha, 'tap commit SHA');
  const verified = await github(request, `${path}?ref=${encodeURIComponent(commitSha)}`, options.tapToken);
  if (decodeCask(verified) !== content) throw new Error('Tap write succeeded but verification did not match.');
  return { status: 'updated', version, sha256, commit: commitSha };
}

function assertSupportedArguments(args: string[]): void {
  if (args.some(argument => argument !== '--dry-run')) throw new Error('Only --dry-run is supported.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertSupportedArguments(process.argv.slice(2));
    const result = await updateHomebrewTap({
      tag: process.env.RELEASE_TAG ?? '',
      sourceToken: process.env.GITHUB_TOKEN,
      tapToken: process.env.HOMEBREW_TAP_TOKEN,
      dryRun: process.argv.includes('--dry-run'),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Homebrew update failed.');
    process.exitCode = 1;
  }
}
