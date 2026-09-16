import type { ForgeConfig } from '@electron-forge/shared-types';
import { fileURLToPath } from 'node:url';

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;
type SigningOptions = Pick<PackagerConfig, 'osxNotarize'> & {
  // Packager handles this option, but the installed Forge types omit it.
  osxSign?: Exclude<PackagerConfig['osxSign'], boolean | undefined> & { continueOnError: false };
};

export function macOSSigningOptions(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): SigningOptions {
  if (environment.CHESHI_SIGN_RELEASE !== '1') return {};
  if (platform !== 'darwin') throw new Error('Signed Cheshi distribution builds require macOS.');

  const identity = requiredSigningValue(environment, 'MACOS_SIGNING_IDENTITY');
  const keychainProfile = requiredSigningValue(environment, 'MACOS_NOTARY_PROFILE');

  return {
    osxSign: {
      identity,
      type: 'distribution',
      continueOnError: false,
      optionsForFile: (filePath) => filePath.endsWith('.app') && !filePath.includes('.app/')
        ? { entitlements: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)) }
        : {},
    },
    osxNotarize: {
      keychainProfile,
    },
  };
}

function requiredSigningValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.signing or the build environment before signing.`);
  return value;
}
