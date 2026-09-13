import path from "node:path";

export const BUNDLED_LANGUAGE_SERVER_PACKAGES = Object.freeze([
  "pyright",
  "typescript",
  "typescript-language-server",
]);

/**
 * Build fallback commands for the JavaScript language servers shipped with
 * Cheshi. Electron's Node mode supplies the runtime in packaged applications,
 * so users do not need a separate Node installation.
 *
 * @param {{ runtimeExecutable: string, modulesDirectory: string }} options
 */
export function createBundledLanguageServerCommands({
  runtimeExecutable,
  modulesDirectory,
}: {
  runtimeExecutable: string;
  modulesDirectory: string;
}) {
  const typescriptServer = path.join(
    modulesDirectory,
    "typescript-language-server",
    "lib",
    "cli.mjs",
  );
  const pythonServer = path.join(
    modulesDirectory,
    "pyright",
    "langserver.index.js",
  );
  const environment = { ELECTRON_RUN_AS_NODE: "1" };
  return {
    typescript: {
      executable: runtimeExecutable,
      args: [typescriptServer, "--stdio"],
      environment,
      availabilityPath: typescriptServer,
      displayPath: typescriptServer,
    },
    python: {
      executable: runtimeExecutable,
      args: [pythonServer, "--stdio"],
      environment,
      availabilityPath: pythonServer,
      displayPath: pythonServer,
    },
  };
}
