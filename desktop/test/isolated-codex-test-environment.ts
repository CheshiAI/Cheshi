/** Prevent local Codex fixtures from inheriting account credentials or database locations. */
export function isolatedCodexTestEnvironment(home: string): Record<string, string | undefined> {
  return {
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: undefined,
    CODEX_ACCESS_TOKEN: undefined,
    CODEX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  };
}
