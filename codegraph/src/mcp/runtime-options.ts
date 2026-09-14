/** App-managed MCP reads the index owned by the desktop indexing service. */
export function mcpReadOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEGRAPH_MCP_READ_ONLY === '1';
}
