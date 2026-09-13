import { describe, expect, it } from 'bun:test';
import {
  buildBunRuntimeBanner,
  isUnsupportedBunVersion,
  MIN_BUN_VERSION,
} from '../src/bin/bun-version-check';

describe('Bun runtime check', () => {
  it('rejects a missing or outdated Bun runtime', () => {
    expect(isUnsupportedBunVersion(undefined)).toBe(true);
    expect(isUnsupportedBunVersion('1.3.13')).toBe(true);
  });

  it('accepts the supported floor and newer releases', () => {
    expect(MIN_BUN_VERSION).toBe('1.3.14');
    expect(isUnsupportedBunVersion('1.3.14')).toBe(false);
    expect(isUnsupportedBunVersion('1.4.0')).toBe(false);
    expect(isUnsupportedBunVersion('2.0.0')).toBe(false);
  });

  it('explains how to start CodeGraph with Bun', () => {
    const banner = buildBunRuntimeBanner('1.2.0');
    expect(banner).toContain('Bun 1.2.0');
    expect(banner).toContain(`Bun ${MIN_BUN_VERSION} or newer`);
    expect(banner).toContain('`bun`');
  });

  it('identifies non-Bun runtimes', () => {
    expect(buildBunRuntimeBanner(undefined)).toContain('non-Bun');
  });
});
