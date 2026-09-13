import packageMetadata from '../../package.json';

/**
 * One version for CLI output, index metadata, installers, and daemon handshakes.
 * A static JSON import is embedded by Bun in compiled runtimes, so installed
 * apps never need the build machine's source checkout to resolve this value.
 */
export const CodeGraphPackageVersion = packageMetadata.version;
