import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { comparePublicVersions, prepareCaskUpdate, updateHomebrewTap } from '../../scripts/update-homebrew-tap.mts';

const archive = 'test release archive';
const checksum = createHash('sha256').update(archive).digest('hex');
const cask = `cask "cheshi" do
  version "0.0.2-preview"
  sha256 "${'0'.repeat(64)}"

  url "https://github.com/CheshiAI/Cheshi/releases/download/v#{version}/Cheshi-darwin-arm64-#{version}.zip"
  livecheck do
    skip "Preview releases are updated manually"
  end
  auto_updates true
  depends_on arch: :arm64
  depends_on cask: "codex"
  depends_on formula: "gh"
  depends_on macos: :tahoe
  app "Cheshi.app"
end
`;
const options = { tag: 'v0.0.3-preview', sourceToken: 'test-source', tapToken: 'test-tap' };

function fixture() {
  const asset = {
    name: 'Cheshi-darwin-arm64-0.0.3-preview.zip', state: 'uploaded', size: Buffer.byteLength(archive),
    digest: `sha256:${checksum}`,
    browser_download_url: 'https://github.com/CheshiAI/Cheshi/releases/download/v0.0.3-preview/Cheshi-darwin-arm64-0.0.3-preview.zip',
  };
  const release: Record<string, unknown> = {
    tag_name: options.tag, draft: false, published_at: '2026-09-16T00:00:00Z', assets: [asset],
  };
  let content = cask;
  let writeStatus = 200;
  const writes: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const authorization = new Headers(init?.headers).get('Authorization');
    if (url.startsWith('https://github.com/')) {
      expect(authorization).toBeNull();
      return new Response(archive);
    }
    if (url.includes('/CheshiAI/Cheshi/releases/')) {
      expect(authorization).toBe('Bearer test-source');
      return Response.json(release);
    }
    expect(url).toStartWith('https://api.github.com/repos/CheshiAI/homebrew-tap/contents/Casks/cheshi.rb');
    expect(authorization).toBe('Bearer test-tap');
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      if (writeStatus !== 200) return new Response(null, { status: writeStatus });
      content = Buffer.from(String(body.content), 'base64').toString('utf8');
      return Response.json({ commit: { sha: 'verified-commit' } });
    }
    return Response.json({ path: 'Casks/cheshi.rb', type: 'file', encoding: 'base64', sha: 'original-blob',
      content: Buffer.from(content).toString('base64') });
  };
  return { asset, release, request, calls, writes,
    setContent(value: string) { content = value; },
    failWrite(status: number) { writeStatus = status; },
  };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('orders public versions numerically with preview below the matching stable release', () => {
  for (const [older, newer] of [
    ['0.0.9-preview', '0.0.10-preview'], ['0.0.3-preview', '0.0.3-preview.1'],
    ['0.0.3-preview.2', '0.0.3-preview.10'], ['0.0.3-preview.10', '0.0.3'], ['0.0.3', '0.0.4-preview'],
  ]) {
    expect(comparePublicVersions(older!, newer!)).toBe(-1);
    expect(comparePublicVersions(newer!, older!)).toBe(1);
  }
  expect(comparePublicVersions('0.0.3-preview', '0.0.3-preview')).toBe(0);
  expect(() => comparePublicVersions('0.0.3-preview.01', '0.0.2')).toThrow('Unsupported public version');
});

test('publishes only the verified cask update using its original blob SHA, then reads the new commit', async () => {
  const app = fixture();
  expect(await updateHomebrewTap(options, app.request)).toEqual({
    status: 'updated', version: '0.0.3-preview', sha256: checksum, commit: 'verified-commit',
  });
  expect(app.writes).toHaveLength(1);
  expect(app.writes[0]).toMatchObject({ branch: 'main', sha: 'original-blob', message: '[build] update cheshi to 0.0.3-preview' });
  const updated = Buffer.from(String(app.writes[0]?.content), 'base64').toString('utf8');
  expect(updated).toContain('version "0.0.3-preview"');
  expect(updated).toContain(`sha256 "${checksum}"`);
  expect(updated).toContain('depends_on macos: :tahoe');
  expect(updated).toContain('depends_on cask: "codex"');
  expect(updated).toContain('Updated by the Cheshi release workflow');
  expect(app.calls.at(-1)).toEndWith('?ref=verified-commit');
});

test('a repeated release or an older release makes no commit', async () => {
  const app = fixture();
  app.setContent(prepareCaskUpdate(cask, '0.0.3-preview', checksum)!);
  expect((await updateHomebrewTap(options, app.request)).status).toBe('unchanged');
  app.setContent(prepareCaskUpdate(cask, '0.0.4-preview', checksum)!);
  expect((await updateHomebrewTap(options, app.request)).status).toBe('unchanged');
  expect(app.writes).toHaveLength(0);
});

test('a replaced asset for the same version cannot silently change its checksum', async () => {
  const app = fixture();
  app.setContent(cask.replace('0.0.2-preview', '0.0.3-preview'));
  await expectFailure(updateHomebrewTap(options, app.request), 'different SHA256');
  expect(app.writes).toHaveLength(0);
});

test('dry run downloads and verifies the release without writing the tap', async () => {
  const app = fixture();
  const result = await updateHomebrewTap({ ...options, dryRun: true }, app.request);
  expect(result.status).toBe('dry-run');
  expect(result.sha256).toBe(checksum);
  expect(app.writes).toHaveLength(0);
});

test('alpha releases do not touch Homebrew and malformed public tags are rejected', async () => {
  const app = fixture();
  expect((await updateHomebrewTap({ tag: 'v0.0.4-alpha' }, app.request)).status).toBe('skipped-alpha');
  for (const tag of ['v0.0.3; echo unsafe', '0.0.3', 'v0.0.3-beta', 'v00.0.3']) {
    await expectFailure(updateHomebrewTap({ ...options, tag }, app.request), tag === '0.0.3' ? 'start with v' : 'Unsupported');
  }
  expect(app.calls).toHaveLength(0);
});

test('a missing tap credential fails before network access', async () => {
  const app = fixture();
  await expectFailure(updateHomebrewTap({ tag: options.tag }, app.request), 'HOMEBREW_TAP_TOKEN');
  expect(app.calls).toHaveLength(0);
});

test('draft and mismatched releases cannot write the tap', async () => {
  for (const patch of [{ draft: true }, { draft: 'false' }, { tag_name: 'v0.0.2-preview' }, { published_at: null }]) {
    const app = fixture();
    Object.assign(app.release, patch);
    await expectFailure(updateHomebrewTap(options, app.request), 'must be published');
    expect(app.writes).toHaveLength(0);
  }
});

test('a missing or duplicate architecture asset cannot write the tap', async () => {
  for (const duplicate of [false, true]) {
    const app = fixture();
    app.release.assets = duplicate ? [app.asset, app.asset] : [];
    await expectFailure(updateHomebrewTap(options, app.request), 'exactly one');
    expect(app.writes).toHaveLength(0);
  }
});

test('an external URL or absent digest is rejected before downloading', async () => {
  for (const patch of [{ browser_download_url: 'https://example.org/asset.zip' }, { digest: null }, { state: 'new' }, { size: 0 }]) {
    const app = fixture();
    Object.assign(app.asset, patch);
    await expectFailure(updateHomebrewTap(options, app.request), 'is invalid');
    expect(app.calls).toHaveLength(1);
  }
});

test('actual bytes must match both the GitHub size and digest', async () => {
  for (const patch of [{ size: 1 }, { size: 1000 }, { digest: `sha256:${'f'.repeat(64)}` }]) {
    const app = fixture();
    Object.assign(app.asset, patch);
    await expectFailure(updateHomebrewTap(options, app.request), 'Release asset');
    expect(app.writes).toHaveLength(0);
  }
});

test('ambiguous cask fields and unexpected URL templates are not overwritten', () => {
  expect(() => prepareCaskUpdate(`${cask}\n  version "1.0.0"`, '0.0.3-preview', checksum)).toThrow('exactly one');
  expect(() => prepareCaskUpdate(cask.replace('github.com', 'example.org'), '0.0.3-preview', checksum)).toThrow('URL template');
});

test('a concurrent tap edit fails without retrying or overwriting that edit', async () => {
  const app = fixture();
  app.failWrite(409);
  await expectFailure(updateHomebrewTap(options, app.request), 'HTTP 409');
  expect(app.writes).toHaveLength(1);
});
