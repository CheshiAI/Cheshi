import { describe, expect, test } from 'bun:test';
import { deepStrictEqual } from 'node:assert/strict';
import { btoa } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isAllowedRemotePluginLogoUrl,
  pluginLogoDataUrl,
} from '../lib/plugin-logo-service.mts';

describe('plugin logo service', () => {
  test('accepts only the official remote logo hosts over HTTPS', () => {
    const insecureLogoUrl = new URL('https://files.openai.com/content?id=logo');
    insecureLogoUrl.protocol = 'http:';

    expect(isAllowedRemotePluginLogoUrl('https://files.openai.com/content?id=logo')).toBe(true);
    expect(isAllowedRemotePluginLogoUrl('https://chatgpt.com/backend-api/files/logo')).toBe(true);
    expect(isAllowedRemotePluginLogoUrl(insecureLogoUrl.href)).toBe(false);
    expect(isAllowedRemotePluginLogoUrl('https://user:secret@files.openai.com/content')).toBe(false);
    expect(isAllowedRemotePluginLogoUrl('https://127.0.0.1/logo.png')).toBe(false);
    expect(isAllowedRemotePluginLogoUrl('https://example.com/logo.png')).toBe(false);
  });

  test('converts an allowed local image into a data URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cheshi-plugin-logo-'));
    const logoPath = join(directory, 'logo.svg');
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>';
    try {
      await writeFile(logoPath, source);
      deepStrictEqual(
        await pluginLogoDataUrl({ kind: 'local', value: logoPath }),
        `data:image/svg+xml;base64,${btoa(source)}`,
      );
      expect(await pluginLogoDataUrl({ kind: 'local', value: join(directory, 'logo.txt') })).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects an unapproved remote source before fetching it', async () => {
    expect(await pluginLogoDataUrl({ kind: 'remote', value: 'https://example.com/logo.png' })).toBeNull();
  });
});
