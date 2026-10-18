import assert from 'node:assert/strict';
import test from 'node:test';
import { macOSCertificateSigningEnabled, macOSSigningOptions } from '../../config/macos-signing.mts';
import { localSigningEnvironment, parseMacOSBuildSignature } from '../../scripts/macos-build-signing.mts';

const hash = 'A'.repeat(40);
const name = 'Developer ID Application: Example Company (EXAMPLE123)';
const listing = `  1) ${hash} "${name}"\n  2) ${'B'.repeat(40)} "Apple Development: Example (EXAMPLE123)"\n  2 valid identities found\n`;
const readIdentities = () => listing;

test('local and release signing both require Bun executable normalization', () => {
  assert.equal(macOSCertificateSigningEnabled({ CHESHI_SIGN_LOCAL: '1' }), true);
  assert.equal(macOSCertificateSigningEnabled({ CHESHI_SIGN_RELEASE: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'false']) {
    assert.equal(macOSCertificateSigningEnabled({ CHESHI_SIGN_LOCAL: value, CHESHI_SIGN_RELEASE: value }), false);
  }
});

test('local packages select a valid Developer ID certificate and sign without notarization', () => {
  const environment = localSigningEnvironment({}, 'darwin', readIdentities);
  assert.deepEqual(environment, { CHESHI_SIGN_LOCAL: '1', MACOS_SIGNING_IDENTITY: hash });
  const options = macOSSigningOptions(environment, 'darwin');
  assert.equal(options.osxSign?.identity, hash);
  assert.equal(options.osxSign?.continueOnError, false);
  assert.equal(options.osxSign?.type, 'distribution');
  assert.equal(options.osxNotarize, undefined);
  assert.ok(options.osxSign?.optionsForFile?.('/output/Cheshi.app').entitlements);
});

test('explicit exact certificate name or fingerprint resolves ambiguity', () => {
  const multiple = () => listing + `  3) ${'C'.repeat(40)} "Developer ID Application: Other (OTHER12345)"\n`;
  for (const requested of [name, hash.toLowerCase()]) {
    assert.equal(localSigningEnvironment({ MACOS_SIGNING_IDENTITY: requested }, 'darwin', multiple).MACOS_SIGNING_IDENTITY, hash);
  }
  assert.throws(() => localSigningEnvironment({}, 'darwin', multiple), /one valid Developer ID/);
});

test('missing, invalid and ad-hoc identities fail instead of silently changing app identity', () => {
  assert.throws(() => localSigningEnvironment({}, 'darwin', () => '0 valid identities found'), /one valid Developer ID/);
  for (const identity of ['-', 'Example', 'Apple Development: Example (EXAMPLE123)']) {
    assert.throws(() => localSigningEnvironment({ MACOS_SIGNING_IDENTITY: identity }, 'darwin', readIdentities), /one valid Developer ID/);
  }
  assert.throws(() => localSigningEnvironment({}, 'darwin', () => { throw new Error('Keychain unavailable'); }), /Keychain unavailable/);
  assert.throws(() => macOSSigningOptions({ CHESHI_SIGN_LOCAL: '1', MACOS_SIGNING_IDENTITY: '-' }, 'darwin'), /ad-hoc/);
});

test('non-macOS and release builds do not inspect local identities or override release configuration', () => {
  const unexpected = () => { throw new Error('Unexpected keychain lookup'); };
  assert.deepEqual(localSigningEnvironment({}, 'linux', unexpected), {});
  const release = { CHESHI_SIGN_RELEASE: '1', CHESHI_SIGN_LOCAL: '1', MACOS_SIGNING_IDENTITY: name, MACOS_NOTARY_PROFILE: 'Release' };
  assert.deepEqual(localSigningEnvironment(release, 'darwin', unexpected), {});
  assert.deepEqual(macOSSigningOptions(release, 'darwin').osxNotarize, { keychainProfile: 'Release' });
  assert.throws(() => macOSSigningOptions({ ...release, MACOS_NOTARY_PROFILE: '' }, 'darwin'), /MACOS_NOTARY_PROFILE/);
  for (const setting of ['true', 'false', '0', '']) {
    assert.deepEqual(macOSSigningOptions({ CHESHI_SIGN_LOCAL: setting }, 'darwin'), {});
  }
});

const requirement = 'identifier "ai.cheshi.desktop" and anchor apple generic and certificate leaf[subject.OU] = EXAMPLE123';
const details = `Identifier=ai.cheshi.desktop\nAuthority=${name}\nTeamIdentifier=EXAMPLE123\ndesignated => ${requirement}\n`;

test('signature metadata retains the certificate-based identity rather than the changing code hash', () => {
  const first = parseMacOSBuildSignature(details + 'CDHash=first\n', 'ai.cheshi.desktop');
  const next = parseMacOSBuildSignature(details + 'CDHash=second\n', 'ai.cheshi.desktop');
  assert.deepEqual(first, next);
  assert.deepEqual(first, { identifier: 'ai.cheshi.desktop', teamIdentifier: 'EXAMPLE123', designatedRequirement: requirement });
});

test('signature inspection rejects ad-hoc, missing, wrong-bundle and hash-bound identities', () => {
  for (const invalid of [details + 'Signature=adhoc\n', details.replace('TeamIdentifier=EXAMPLE123', 'TeamIdentifier=not set'),
    details.replace(requirement, 'cdhash H"abcd"'), details.replace(`Authority=${name}`, 'Authority=Apple Development: Example'),
    details.replace('designated =>', 'missing =>')]) {
    assert.throws(() => parseMacOSBuildSignature(invalid, 'ai.cheshi.desktop'), /stable designated requirement/);
  }
  assert.throws(() => parseMacOSBuildSignature(details, 'another.app'), /stable designated requirement/);
});
