export interface PythonDistribution {
  id: string; version: string; url: string; sha256: string; bytes: number; executable: string;
}

// Release assets and SHA-256 values from the publisher's GitHub release API.
// Never resolve "latest" at runtime or accept a package-provided download URL.
export const DEFAULT_HOST_PYTHON_VERSION = '3.14.8';
const release = '20261013';
const macDistributions = {
  arm64: { target: 'aarch64-apple-darwin', bytes: 26678949,
    sha256: '994adadc202c5df0b4570192cc9a70e3f2c131e512f4a125c56efa8562f44b28' },
  x64: { target: 'x86_64-apple-darwin', bytes: 26894901,
    sha256: 'f0137337ecf6234b30c9c955219dae2d71e1a00387c4d204d6c6929e24bf9a90' },
} as const;

export function hostPythonDistribution(version = DEFAULT_HOST_PYTHON_VERSION, platform: string = process.platform, arch: string = process.arch): PythonDistribution {
  if (version !== DEFAULT_HOST_PYTHON_VERSION) throw new Error(`Python ${version} is not included in this Cheshi runtime catalog. Update Cheshi or choose ${DEFAULT_HOST_PYTHON_VERSION}.`);
  if (platform !== 'darwin' || !(arch in macDistributions)) throw new Error(`Managed host Python is not available for ${platform}/${arch}.`);
  const item = macDistributions[arch as keyof typeof macDistributions];
  const name = `cpython-${version}+${release}-${item.target}-install_only_stripped.tar.gz`;
  return { id: `cpython-${version}-${release}-${item.target}-${item.sha256.slice(0, 16)}`, version,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${encodeURIComponent(name)}`,
    sha256: item.sha256, bytes: item.bytes, executable: 'python/bin/python3.14' };
}
