import { codegraphTools } from './codegraph-tools.ts';
import { collaborationTools } from './collaboration-tools.ts';
import { verificationTools } from './verification-tools.ts';
import { workTools } from './work-tools.ts';
import { integrationTools, applicationTools } from './integration.ts';

export const PACK_TOOLS = ['codegraph', 'collaboration', 'verification'] as const;
export type PackTool = typeof PACK_TOOLS[number];
export function parseEnabledPackTools(value: unknown): PackTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => !PACK_TOOLS.includes(item))) throw new TypeError('Invalid Homie tool selection.');
  return [...new Set(value)] as PackTool[];
}
export function packToolAllowed(enabled: readonly string[] | undefined, name: string): boolean {
  if (!enabled) return true;
  if (codegraphTools.some(tool => tool.name === name)) return enabled.includes('codegraph');
  if (verificationTools.some(tool => tool.name === name)) return enabled.includes('verification');
  if (name === 'request_verification' || integrationTools.some(tool => tool.name === name) || applicationTools.some(tool => tool.name === name)) {
    return enabled.includes('collaboration') && enabled.includes('verification');
  }
  if (collaborationTools.some(tool => tool.name === name) || workTools.some(tool => tool.name === name)) return enabled.includes('collaboration');
  return true;
}

export function assertPackToolAllowed(enabled: readonly string[] | undefined, name: string): void {
  if (!packToolAllowed(enabled, name)) throw new Error('This tool is disabled in the Homie pack. Enable it and restart the idle worker.');
}
