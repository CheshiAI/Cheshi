import type { ForgeConfig } from '@electron-forge/shared-types';
import { fileURLToPath } from 'node:url';

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;
type SigningOptions = Pick<PackagerConfig, 'osxNotarize'> & {
  // Packager handles this option, but the installed Forge types omit it.
  osxSign?: Exclude<PackagerConfig['osxSign'], boolean | undefined> & { continueOnError: false };
};

export function macOSSigningOptions(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): SigningOptions {
  const release = environment.CHESHI_SIGN_RELEASE === '1';
  if (!release && environment.CHESHI_SIGN_LOCAL !== '1') return {};
  if (platform !== 'darwin') throw new Error('Signed Cheshi builds require macOS.');

  const identity = requiredSigningValue(environment, 'MACOS_SIGNING_IDENTITY');
  const keychainProfile = release ? requiredSigningValue(environment, 'MACOS_NOTARY_PROFILE') : undefined;
  if (identity === '-') throw new Error('A persistent signing identity is required; ad-hoc signing cannot preserve app identity.');

  return {
    osxSign: {
      identity,
      type: 'distribution',
      continueOnError: false,
      optionsForFile: (filePath) => filePath.endsWith('.app') && !filePath.includes('.app/')
        ? { entitlements: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)) }
        : {},
    },
    ...(keychainProfile ? { osxNotarize: { keychainProfile } } : {}),
  };
}

function requiredSigningValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.signing or the build environment before signing.`);
  return value;
}
