import { createHash } from 'node:crypto';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { product } from '../config/product.mts';

const usage = 'Cheshi displays your calendars and creates, edits, or deletes the events you choose.';
const automationUsage = 'Cheshi reads and manages your Mail messages, sends mail you confirm, and reads or saves Apple Notes when you ask.';
const rootDirectory = fileURLToPath(new URL('..', import.meta.url));

export function developmentAppIdentity(root: string) {
  const suffix = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
  return { name: `${product.displayName} Development`, bundleId: `${product.bundleId}.development.checkout-${suffix}` };
}

export function prepareCalendarDevelopment(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const require = createRequire(import.meta.url);
  const executable: unknown = require('electron');
  if (typeof executable !== 'string' || !executable.endsWith('/Contents/MacOS/Electron')) {
    throw new Error('Could not locate this checkout’s development Electron bundle.');
  }
  return prepareDevelopmentApp(path.resolve(executable, '../../..'), rootDirectory);
}

export function prepareDevelopmentApp(sourceBundle: string, root: string): string {
  const directory = path.join(root, 'desktop', '.development');
  const identity = developmentAppIdentity(root);
  const bundle = path.join(directory, `${identity.name}.app`);
  const marker = path.join(directory, 'bundle.json');
  const icon = path.join(root, 'resources', 'icons', 'app-icon.icns');
  const executable = statSync(path.join(sourceBundle, 'Contents', 'MacOS', 'Electron'));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ identity, usage, automationUsage, revision: 3, sourceBundle, size: executable.size, mtime: executable.mtimeMs }))
    .update(readFileSync(path.join(sourceBundle, 'Contents', 'Info.plist')))
    .update(readFileSync(icon)).digest('hex');
  if (existsSync(marker) && existsSync(bundle) && readFileSync(marker, 'utf8') === fingerprint) {
    verifySignature(bundle);
    return bundle;
  }
  if (existsSync(bundle)) {
    const running = Bun.spawnSync(['/bin/ps', '-ww', '-axo', 'comm='], { stdout: 'pipe', stderr: 'pipe' });
    if (running.exitCode !== 0) throw new Error('Cannot verify whether the development bundle is in use.');
    if (running.stdout.toString().split('\n').some(command => command.trim().startsWith(`${bundle}/`))) {
      throw new Error('Close this checkout’s Cheshi Development app before updating its Electron bundle.');
    }
  }
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(path.join(directory, '.prepare-'));
  const stagedBundle = path.join(staging, path.basename(bundle));
  try {
    cpSync(sourceBundle, stagedBundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    copyFileSync(icon, path.join(stagedBundle, 'Contents', 'Resources', 'cheshi.icns'));
    prepareCalendarDevelopmentBundle(stagedBundle, identity);
    if (existsSync(bundle)) rmSync(bundle, { recursive: true });
    renameSync(stagedBundle, bundle);
    writeFileSync(marker, fingerprint);
    return bundle;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function prepareCalendarDevelopmentBundle(bundle: string, identity = developmentAppIdentity(rootDirectory)): void {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const values = {
    CFBundleIdentifier: identity.bundleId,
    CFBundleName: identity.name,
    CFBundleDisplayName: identity.name,
    CFBundleIconFile: 'cheshi.icns',
    NSCalendarsFullAccessUsageDescription: usage,
    NSCalendarsUsageDescription: usage,
    NSAppleEventsUsageDescription: automationUsage,
  };
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    const current = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', `Print :${key}`, plist], { stdout: 'pipe', stderr: 'pipe' });
    if (current.exitCode === 0 && current.stdout.toString().trim() === value) continue;
    const command = current.exitCode === 0 ? `Set :${key} ${value}` : `Add :${key} string ${value}`;
    const result = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', command, plist], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error('Could not configure the Cheshi development bundle.');
    changed = true;
  }
  if (changed) {
    const frameworks = path.join(bundle, 'Contents', 'Frameworks');
    if (existsSync(frameworks)) {
      for (const entry of readdirSync(frameworks)) {
        if (!entry.endsWith('.framework') && !entry.endsWith('.app')) continue;
        const nested = Bun.spawnSync(['/usr/bin/codesign', '--force', '--deep', '--sign', '-',
          '--preserve-metadata=identifier,entitlements,flags,runtime', path.join(frameworks, entry)], { stdout: 'pipe', stderr: 'pipe' });
        if (nested.exitCode !== 0) throw new Error(`Could not sign development component: ${entry}`);
      }
    }
    const signed = Bun.spawnSync(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', identity.bundleId,
      '--preserve-metadata=entitlements,flags,runtime', bundle], { stdout: 'pipe', stderr: 'pipe' });
    if (signed.exitCode !== 0) throw new Error('Could not sign the Cheshi development bundle.');
  }
  verifySignature(bundle);
}

function verifySignature(bundle: string): void {
  const verified = Bun.spawnSync(['/usr/bin/codesign', '--verify', '--deep', '--strict', bundle], { stdout: 'pipe', stderr: 'pipe' });
  if (verified.exitCode !== 0) throw new Error('The Cheshi development bundle signature is invalid.');
}
