export type LanguageServerMode = "auto" | "custom" | "disabled";

export interface LanguageServerDefinition {
  displayName: string;
  serverName: string;
  command: string;
  args: string[];
  rootMarkers: string[];
  languageId: (filePath: string) => string;
}

export interface LanguageServerSetting {
  mode: LanguageServerMode;
  executable: string | null;
}

export interface LanguageServerSettings {
  version: number;
  languages: Record<string, LanguageServerSetting>;
}

export interface ResolvedCommand {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  displayPath: string;
}

export interface DocumentPosition {
  line: number;
  character: number;
}

export interface DocumentRange {
  start: DocumentPosition;
  end: DocumentPosition;
}

export interface DocumentUpdate {
  language: string;
  relativePath: string;
  content: string;
  version: number;
}

export interface DocumentFeature extends DocumentUpdate {
  position: DocumentPosition;
}

export type DiagnosticsListener = (value: {
  language: string;
  path: string;
  version: number | null;
  diagnostics: unknown[];
}) => void;
