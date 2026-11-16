import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { retainEnglishAppResources } from '../../scripts/macos-app-language.mts';
import createForgeConfiguration from '../../forge.config.mts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cheshi-menu-language-'));
  const resources = path.join(root, 'Electron.app', 'Contents', 'Resources');
  for (const language of ['en', 'en_GB', 'ko', 'ja']) {
    mkdirSync(path.join(resources, `${language}.lproj`), { recursive: true });
    writeFileSync(path.join(resources, `${language}.lproj`, 'MainMenu.nib'), language);
  }
  const frameworkLocale = path.join(root, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'ko.lproj');
  mkdirSync(frameworkLocale, { recursive: true });
  writeFileSync(path.join(resources, 'app.asar'), 'application');
  return { root, resources, frameworkLocale, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('English-only app resources preserve application data and framework languages and are idempotent', () => {
  const files = fixture();
  try {
    expect(retainEnglishAppResources(files.resources)).toBe(true);
    expect(readFileSync(path.join(files.resources, 'en.lproj', 'MainMenu.nib'), 'utf8')).toBe('en');
    for (const language of ['en_GB', 'ko', 'ja']) expect(existsSync(path.join(files.resources, `${language}.lproj`))).toBe(false);
    expect(readFileSync(path.join(files.resources, 'app.asar'), 'utf8')).toBe('application');
    expect(existsSync(files.frameworkLocale)).toBe(true);
    expect(retainEnglishAppResources(files.resources)).toBe(false);
  } finally { files.dispose(); }
});

test('missing English resources fail before any localization is removed', () => {
  const files = fixture();
  try {
    rmSync(path.join(files.resources, 'en.lproj'), { recursive: true });
    expect(() => retainEnglishAppResources(files.resources)).toThrow('en.lproj');
    expect(existsSync(path.join(files.resources, 'ko.lproj'))).toBe(true);
  } finally { files.dispose(); }
});

test('packaging hook completes for macOS and leaves other platforms unchanged', async () => {
  const config = await createForgeConfiguration();
  expect(config.packagerConfig?.extendInfo).toMatchObject({ CFBundleDevelopmentRegion: 'en' });
  const hooks = config.packagerConfig?.afterCopy;
  expect(hooks?.length).toBe(1);
  for (const platform of ['linux', 'darwin', 'mas'] as const) {
    const files = fixture();
    try {
      for (const hook of hooks!) await promisify(hook)(path.join(files.resources, 'app'), '41.10.7', platform, 'arm64');
      expect(existsSync(path.join(files.resources, 'ko.lproj'))).toBe(platform === 'linux');
      expect(existsSync(path.join(files.resources, 'en.lproj'))).toBe(true);
    } finally { files.dispose(); }
  }
});

test('packaging reports missing English resources through its completion callback', async () => {
  const config = await createForgeConfiguration();
  const files = fixture();
  try {
    rmSync(path.join(files.resources, 'en.lproj'), { recursive: true });
    const error = await new Promise<Error | null | undefined>(resolve => {
      config.packagerConfig!.afterCopy![0]!(path.join(files.resources, 'app'), '41.10.7', 'darwin', 'arm64', resolve);
    });
    expect(error?.message).toContain('en.lproj');
    expect(existsSync(path.join(files.resources, 'ko.lproj'))).toBe(true);
  } finally { files.dispose(); }
});
