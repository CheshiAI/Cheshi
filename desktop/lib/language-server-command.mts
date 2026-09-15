import { recordValue } from "./codex-service-utils.mts";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ResolvedCommand } from "./language-server-types.mts";

export function isExecutable(filePath: string) {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(
      filePath,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function isRegularFile(filePath: string) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function normalizeBundledCommand(value: unknown) {
  const command = recordValue(value);
  if (
    !command ||
    typeof command.executable !== "string" ||
    !isExecutable(command.executable)
  )
    return null;
  if (
    !Array.isArray(command.args) ||
    !command.args.every((argument) => typeof argument === "string")
  )
    return null;
  if (
    typeof command.availabilityPath !== "string" ||
    !isRegularFile(command.availabilityPath)
  )
    return null;
  const environmentValue = recordValue(command.environment);
  const environment: NodeJS.ProcessEnv = environmentValue
    ? (Object.fromEntries(
        Object.entries(environmentValue).filter(
          (entry) => typeof entry[1] === "string",
        ),
      ) as NodeJS.ProcessEnv)
    : {};
  return {
    executable: path.resolve(command.executable),
    args: [...command.args],
    environment,
    displayPath:
      typeof command.displayPath === "string" && command.displayPath
        ? path.resolve(command.displayPath)
        : path.resolve(command.availabilityPath),
  };
}

function nodeScriptPath(executable: string): string | null {
  let descriptor: number | undefined;
  try {
    const script = realpathSync(executable);
    descriptor = openSync(script, "r");
    const buffer = Buffer.alloc(512);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = buffer.toString("utf8", 0, length).split("\n", 1)[0] ?? "";
    // Only plain Node shebangs are interchangeable with the bundled runtime.
    // Shell wrappers and interpreters with explicit flags retain their semantics.
    return /^#![\t ]*(?:\/usr\/bin\/env[\t ]+node|\/[^\s]*\/node)[\t ]*\r?$/.test(header)
      ? script : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function withBundledNodeRuntime(command: ResolvedCommand, bundled: ResolvedCommand | null): ResolvedCommand {
  if (!bundled) return command;
  const script = nodeScriptPath(command.executable);
  if (!script) return command;
  return {
    executable: bundled.executable,
    args: [script, ...command.args],
    environment: { ...command.environment, ...bundled.environment },
    displayPath: command.displayPath,
  };
}

function executableNames(command: string) {
  if (process.platform !== "win32") return [command];
  return path.extname(command)
    ? [command]
    : [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
}

function commandCandidates(
  command: string,
  workspaceRoot: string,
  projectRoot: string,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
) {
  if (path.isAbsolute(command)) return [path.resolve(command)];
  const binDirectories = [
    path.join(projectRoot, "node_modules", ".bin"),
    path.join(workspaceRoot, "node_modules", ".bin"),
    path.join(
      projectRoot,
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
    ),
    path.join(
      projectRoot,
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
    ),
    path.join(homeDirectory, ".cargo", "bin"),
    path.join(homeDirectory, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...String(environment.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean),
  ];
  const candidates = [];
  const seen = new Set();
  for (const directory of binDirectories) {
    for (const name of executableNames(command)) {
      const candidate = path.resolve(directory, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function findExecutable(
  command: string,
  workspaceRoot: string,
  projectRoot: string,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
) {
  return (
    commandCandidates(
      command,
      workspaceRoot,
      projectRoot,
      homeDirectory,
      environment,
    ).find(isExecutable) ?? null
  );
}
