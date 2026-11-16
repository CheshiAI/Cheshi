import { execFileSync, spawnSync } from 'node:child_process';

/** Resolve once before packaging so every nested process uses the same certificate. */
export function localSigningEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  readIdentities = () => execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8', timeout: 20_000 }),
): NodeJS.ProcessEnv {
  if (platform !== 'darwin' || environment.CHESHI_SIGN_RELEASE === '1') return {};
  const identities = [...readIdentities().matchAll(/^\s*\d+\) ([\dA-F]{40}) "(Developer ID Application: [^"\r\n]+)"\s*$/gm)]
    .map(match => ({ hash: match[1]!, name: match[2]! }));
  const requested = environment.MACOS_SIGNING_IDENTITY?.trim();
  const matches = requested ? identities.filter(item => item.hash === requested.toUpperCase() || item.name === requested) : identities;
  if (matches.length !== 1) {
    throw new Error('Local macOS builds require one valid Developer ID Application certificate. '
      + 'Check Keychain access and set MACOS_SIGNING_IDENTITY to its exact name or fingerprint if needed.');
  }
  return { CHESHI_SIGN_LOCAL: '1', MACOS_SIGNING_IDENTITY: matches[0]!.hash };
}

export interface MacOSBuildSignature {
  identifier: string;
  teamIdentifier: string;
  designatedRequirement: string;
}

export function parseMacOSBuildSignature(details: string, expectedIdentifier: string): MacOSBuildSignature {
  const identifier = /^Identifier=(.+)$/m.exec(details)?.[1];
  const teamIdentifier = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1];
  const designatedRequirement = /^designated => (.+)$/m.exec(details)?.[1];
  if (identifier !== expectedIdentifier || !teamIdentifier || !designatedRequirement
    || /^Signature=adhoc$/m.test(details) || /\bcdhash\b/.test(designatedRequirement)
    || !/^Authority=Developer ID Application:/m.test(details)) {
    throw new Error('The packaged app must have a Developer ID signature with a stable designated requirement.');
  }
  return { identifier, teamIdentifier, designatedRequirement };
}

/** Inspect metadata only after cryptographic verification; never accept ad-hoc fallback. */
export function verifyMacOSBuildSignature(app: string, identifier: string): MacOSBuildSignature {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 120_000 });
  const result = spawnSync('/usr/bin/codesign', ['--display', '--requirements', '-', '--verbose=4', app],
    { encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error('Could not inspect the packaged app signature.');
  return parseMacOSBuildSignature(result.stdout + result.stderr, identifier);
}
