import { recordValue } from "./codex-service-utils.mts";
import type {
  LanguageServerDefinition,
  LanguageServerMode,
  LanguageServerSetting,
  LanguageServerSettings,
} from "./language-server-types.mts";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SETTINGS_VERSION = 2;

const LEGACY_SETTINGS_VERSION = 1;

export const LANGUAGE_SERVER_MODES = new Set<LanguageServerMode>([
  "auto",
  "custom",
  "disabled",
]);

/**
 * @param {string} filePath
 * @returns {'javascript' | 'javascriptreact' | 'typescript' | 'typescriptreact'}
 */
export function typescriptLanguageIdForPath(
  filePath: string,
): "javascript" | "javascriptreact" | "typescript" | "typescriptreact" {
  const extension = path.extname(filePath).toLocaleLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs")
    return "javascript";
  if (extension === ".jsx") return "javascriptreact";
  if (extension === ".tsx") return "typescriptreact";
  return "typescript";
}

export const defaultDefinitions: Record<string, LanguageServerDefinition> = {
  rust: {
    displayName: "Rust",
    serverName: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    rootMarkers: ["Cargo.toml"],
    languageId: () => "rust",
  },
  typescript: {
    displayName: "TypeScript",
    serverName: "typescript-language-server",
    command: "typescript-language-server",
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageId: typescriptLanguageIdForPath,
  },
  python: {
    displayName: "Python",
    serverName: "pyright-langserver",
    command: "pyright-langserver",
    args: ["--stdio"],
    rootMarkers: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
    ],
    languageId: () => "python",
  },
};

function defaultSettings(
  definitions: Record<string, LanguageServerDefinition>,
): LanguageServerSettings {
  return {
    version: SETTINGS_VERSION,
    languages: Object.fromEntries(
      Object.keys(definitions).map((language) => [
        language,
        { mode: "auto", executable: null },
      ]),
    ) as Record<string, LanguageServerSetting>,
  };
}

export function readSettings(
  settingsPath: string,
  definitions: Record<string, LanguageServerDefinition>,
) {
  const defaults = defaultSettings(definitions);
  if (!existsSync(settingsPath))
    return { settings: defaults, shouldPersist: false };
  try {
    const parsed = recordValue(JSON.parse(readFileSync(settingsPath, "utf8")));
    if (
      parsed?.version !== SETTINGS_VERSION &&
      parsed?.version !== LEGACY_SETTINGS_VERSION
    ) {
      return { settings: defaults, shouldPersist: false };
    }
    const migrateLegacyDefaults = parsed.version === LEGACY_SETTINGS_VERSION;
    const languages = recordValue(parsed.languages);
    if (!languages)
      return { settings: defaults, shouldPersist: migrateLegacyDefaults };
    for (const language of Object.keys(definitions)) {
      const setting = recordValue(languages[language]);
      if (
        !setting ||
        typeof setting.mode !== "string" ||
        !LANGUAGE_SERVER_MODES.has(setting.mode as LanguageServerMode)
      )
        continue;
      const mode =
        migrateLegacyDefaults && setting.mode === "disabled"
          ? "auto"
          : setting.mode;
      const executable =
        typeof setting.executable === "string" && setting.executable.trim()
          ? setting.executable.trim()
          : null;
      defaults.languages[language] = {
        mode: mode as LanguageServerMode,
        executable: mode === "custom" ? executable : null,
      };
    }
    return { settings: defaults, shouldPersist: migrateLegacyDefaults };
  } catch {
    return { settings: defaults, shouldPersist: false };
  }
}

export function writeSettings(settingsPath: string, settings: LanguageServerSettings) {
  const directory = path.dirname(settingsPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, settingsPath);
    try {
      chmodSync(settingsPath, 0o600);
    } catch {
      // File modes are not available on every supported filesystem.
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function requireLanguage(
  value: unknown,
  definitions: Record<string, LanguageServerDefinition>,
): string {
  if (typeof value !== "string" || !(value in definitions)) {
    throw new TypeError("Language server language is invalid.");
  }
  return value;
}

export function requireDefinition(
  definitions: Record<string, LanguageServerDefinition>,
  language: string,
): LanguageServerDefinition {
  const definition = definitions[language];
  if (!definition) throw new TypeError("Language server language is invalid.");
  return definition;
}

export function requireSetting(
  settings: LanguageServerSettings,
  language: string,
): LanguageServerSetting {
  const setting = settings.languages[language];
  if (!setting) throw new TypeError("Language server language is invalid.");
  return setting;
}
