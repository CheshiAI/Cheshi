import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { compareReleaseVersions, findAppRelease } from '../lib/app-release-checker.mts';

const digest = 'a'.repeat(64);
const repository = 'https://github.com/CheshiAI/Cheshi/releases';

function release(version: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  const tag = `v${version}`;
  const name = `Cheshi-darwin-arm64-${version}.zip`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: version.includes('-'),
    html_url: `${repository}/tag/${tag}`,
    body: 'Fixed startup and restored workspaces.',
    assets: [{ name, size: 1234, digest: `sha256:${digest}`, browser_download_url: `${repository}/download/${tag}/${name}` }],
    ...changes,
  };
}

function createFetch(handler: (input: string, init: RequestInit | undefined) => Promise<Response>): typeof globalThis.fetch {
  // Only the injected fetch boundary omits Bun's unrelated preconnect extension.
  return ((input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof globalThis.fetch;
}

function check(releases: unknown[], currentVersion = '0.0.1-alpha') {
  return findAppRelease({ currentVersion, platform: 'darwin', arch: 'arm64', fetch: createFetch(async () => Response.json(releases)) });
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let rejection: unknown;
  try { await operation; } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}

describe('release version precedence', () => {
  it('compares core versions, channels, numeric identifiers, and stable releases', () => {
    const versions = ['0.0.1-alpha', '0.0.1-alpha.2', '0.0.1-alpha.10', '0.0.1-preview', '0.0.1', '0.0.2-alpha', '0.0.10-preview', '0.1.0', '1.0.0'];
    for (let index = 1; index < versions.length; index++) {
      expect(compareReleaseVersions(versions[index - 1]!, versions[index]!)).toBe(-1);
      expect(compareReleaseVersions(versions[index]!, versions[index - 1]!)).toBe(1);
    }
    expect(compareReleaseVersions('v1.0.0+build.1', '1.0.0+build.2')).toBe(0);
    expect(compareReleaseVersions('1.0.0-alpha.100000000000000000001', '1.0.0-alpha.100000000000000000000')).toBe(1);
    expect(compareReleaseVersions('1.0.0-alpha.1', '1.0.0-alpha.a')).toBe(-1);
  });

  it('rejects malformed SemVer instead of silently guessing', () => {
    for (const version of ['0.01.0', '1.0', '1.0.0-alpha.01', '1.0.0-', '1.0.0+']) {
      expect(() => compareReleaseVersions(version, '1.0.0')).toThrow();
    }
  });
});

describe('GitHub release discovery', () => {
  it('finds a newer alpha and validates the exact packaged asset and digest', async () => {
    expect(await check([release('0.0.2-alpha')])).toEqual({
      version: '0.0.2-alpha', tag: 'v0.0.2-alpha', url: `${repository}/tag/v0.0.2-alpha`,
      notes: 'Fixed startup and restored workspaces.',
      asset: { name: 'Cheshi-darwin-arm64-0.0.2-alpha.zip', size: 1234, sha256: digest, url: `${repository}/download/v0.0.2-alpha/Cheshi-darwin-arm64-0.0.2-alpha.zip` },
    });
  });

  it('does not notify for the same or older version', async () => {
    expect(await check([release('0.0.1-alpha'), release('0.0.0-alpha')])).toBeNull();
  });

  it('selects by SemVer instead of publication ordering, skipping drafts and unrelated tags', async () => {
    const found = await check([release('0.0.5-alpha', { draft: true }), release('0.0.3-alpha'), release('0.0.2-alpha'), release('not-a-version')]);
    expect(found?.version).toBe('0.0.3-alpha');
  });

  it('keeps preview users off alpha and stable users off prereleases', async () => {
    const versions = [release('0.0.9-alpha'), release('0.0.8-preview'), release('0.0.7'), release('0.0.10', { prerelease: true })];
    expect((await check(versions, '0.0.1-preview'))?.version).toBe('0.0.10');
    expect((await check(versions, '0.0.1'))?.version).toBe('0.0.7');
    expect((await check([release('0.0.9-alpha'), release('0.0.2-preview')], '0.0.1-preview'))?.version).toBe('0.0.2-preview');
    expect((await check([release('0.0.2-preview')]))?.version).toBe('0.0.2-preview');
  });

  it('requires literal boolean flags', async () => {
    for (const flags of [{ draft: 'false' }, { draft: null }, { prerelease: 1 }, { prerelease: undefined }]) {
      await expectFailure(check([release('0.0.2-alpha', flags)]), 'flags');
    }
  });

  it('allows notification without a matching installable asset and bounds release notes', async () => {
    const found = await check([release('0.0.2-alpha', { assets: [], body: 'x'.repeat(20_000) })]);
    expect(found?.asset).toBeNull();
    expect(found?.notes.length).toBe(16_000);
    expect((await check([release('0.0.2-alpha', { body: null })]))?.notes).toBe('');
  });

  it('accepts the alternate version-first archive naming', async () => {
    const name = 'Cheshi-0.0.2-alpha-darwin-arm64.zip';
    const found = await check([release('0.0.2-alpha', { assets: [{ name, size: 123, digest: `sha256:${digest}`, browser_download_url: `${repository}/download/v0.0.2-alpha/${name}` }] })]);
    expect(found?.asset?.name).toBe(name);
  });

  it('rejects untrusted release URLs', async () => {
    for (const url of ['http://github.com/CheshiAI/Cheshi/releases/tag/v0.0.2-alpha', 'https://github.com.evil.test/CheshiAI/Cheshi/releases/tag/v0.0.2-alpha', 'https://user@github.com/CheshiAI/Cheshi/releases/tag/v0.0.2-alpha', `${repository}/tag/v0.0.3-alpha`, `${repository}/tag/v0.0.2-alpha?redirect=1`]) {
      await expectFailure(check([release('0.0.2-alpha', { html_url: url })]), 'details');
    }
  });

  it('never installs source archives, another architecture, missing digests, or untrusted downloads', async () => {
    const name = 'Cheshi-darwin-arm64-0.0.2-alpha.zip';
    const valid = { name, size: 123, digest: `sha256:${digest}`, browser_download_url: `${repository}/download/v0.0.2-alpha/${name}` };
    for (const changes of [{ name: 'Source code.zip' }, { name: name.replace('arm64', 'x64') }, { digest: null }, { digest: 'sha256:abc' }, { size: 0 }, { browser_download_url: `https://evil.test/${name}` }, { browser_download_url: `${repository}/download/v0.0.9-alpha/${name}` }]) {
      expect((await check([release('0.0.2-alpha', { assets: [{ ...valid, ...changes }] })]))?.asset).toBeNull();
    }
  });

  it('scans later pages and only returns after complete success', async () => {
    const requested: string[] = [];
    const found = await findAppRelease({ currentVersion: '0.0.1-alpha', platform: 'darwin', arch: 'arm64', fetch: createFetch(async (url) => {
      requested.push(url);
      return requested.length === 1
        ? Response.json([release('0.0.2-alpha')], { headers: { link: '<https://api.github.com/repos/CheshiAI/Cheshi/releases?per_page=100&page=2>; rel="next"' } })
        : Response.json([release('0.0.3-alpha')]);
    }) });
    expect(requested).toHaveLength(2);
    expect(found?.version).toBe('0.0.3-alpha');
  });

  it('preserves failure when a later page fails rather than publishing partial results', async () => {
    let calls = 0;
    await expectFailure(findAppRelease({ currentVersion: '0.0.1-alpha', platform: 'darwin', arch: 'arm64', fetch: createFetch(async () => ++calls === 1
      ? Response.json([release('0.0.2-alpha')], { headers: { link: '<https://api.github.com/repos/CheshiAI/Cheshi/releases?per_page=100&page=2>; rel="next"' } })
      : new Response('', { status: 404 })) }), '404');
  });

  it('rejects pagination that cannot be completely scanned or points outside the API', async () => {
    let calls = 0;
    await expectFailure(findAppRelease({ currentVersion: '0.0.1-alpha', platform: 'darwin', arch: 'arm64', fetch: createFetch(async () => {
      calls++;
      return Response.json([], { headers: { link: `<https://api.github.com/repos/CheshiAI/Cheshi/releases?per_page=100&page=${calls + 1}>; rel="next"` } });
    }) }), 'pagination limit');
    expect(calls).toBe(10);
    await expectFailure(findAppRelease({ currentVersion: '0.0.1-alpha', platform: 'darwin', arch: 'arm64', fetch: createFetch(async () => Response.json([], { headers: { link: '<https://evil.test/?page=2&per_page=100>; rel="next"' } })) }), 'pagination');
  });

  it('treats an empty repository as no update and propagates HTTP and malformed responses', async () => {
    const run = (response: Response) => findAppRelease({ currentVersion: '0.0.1-alpha', platform: 'darwin', arch: 'arm64', fetch: createFetch(async () => response) });
    expect(await run(new Response('', { status: 404 }))).toBeNull();
    await expectFailure(run(new Response('', { status: 403 })), '403');
    await expectFailure(run(Response.json({ message: 'unexpected' })), 'list');
    await expectFailure(check([release('0.0.2-alpha', { assets: null })]), 'details');
  });

  it('aborts a stalled response body without waiting for body completion', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const operation = findAppRelease({ currentVersion: '0.0.1-alpha', platform: 'darwin', arch: 'arm64', signal: controller.signal, fetch: createFetch(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>());
    }) });
    await Promise.resolve();
    controller.abort(new Error('stop release check'));
    await expectFailure(operation, 'stop release check');
    expect(requestSignal?.aborted).toBe(true);
  });

  it('loads under native Node strip-only TypeScript', () => {
    const result = spawnSync('node', ['--input-type=module', '-e', "await import('./desktop/lib/app-release-checker.mts')"], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
