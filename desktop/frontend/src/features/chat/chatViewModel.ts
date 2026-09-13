import {
  Bot,
  Brain,
  Command,
  Database,
  Gauge,
  GitFork,
  Minimize2,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';

import type {
  ChatConfiguration,
  ChatGoal,
  ChatMcpServer,
  ChatModel,
} from './model';

export type SlashCommandName =
  | 'new'
  | 'agent'
  | 'fork'
  | 'compact'
  | 'review'
  | 'model'
  | 'reasoning'
  | 'fast'
  | 'status'
  | 'mcp'
  | 'goal'
  | 'permissions'
  | 'skills';

export interface SlashCommand {
  name: SlashCommandName;
  label: string;
  description: string;
  meta: string;
  icon: typeof Command;
  requiresSession?: boolean;
}

export type CommandMenuMode =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'models'
  | 'reasoning'
  | 'status'
  | 'mcp'
  | 'goal'
  | 'permissions';

export type ConfigurationMenuView = 'root' | 'models' | 'reasoning' | 'service-tier';

export interface ConfigurationMenuPosition {
  bottom: number;
  left: number;
  submenuSide: 'left' | 'right';
  width: number;
}

export const CONFIGURATION_MENU_WIDTH = 224;
export const CONFIGURATION_SUBMENU_WIDTH = 240;

export const slashCommands: readonly SlashCommand[] = [
  { name: 'new', label: 'New chat', description: 'Start a new local chat', meta: 'chat', icon: Plus },
  { name: 'agent', label: 'Agent threads', description: 'Switch to a main or subagent thread', meta: 'chat', icon: Users, requiresSession: true },
  { name: 'fork', label: 'Fork chat', description: 'Copy this local chat into a new chat', meta: 'chat', icon: GitFork, requiresSession: true },
  { name: 'compact', label: 'Compact context', description: 'Compact the current chat context', meta: 'chat', icon: Minimize2, requiresSession: true },
  { name: 'review', label: 'Code review', description: 'Review uncommitted workspace changes', meta: 'development', icon: Search },
  { name: 'model', label: 'Model', description: 'Choose the model for this chat', meta: 'configure', icon: Bot },
  { name: 'reasoning', label: 'Reasoning', description: 'Choose the reasoning effort', meta: 'configure', icon: Brain },
  { name: 'fast', label: 'Fast mode', description: 'Turn the catalog-provided Fast service tier on or off', meta: 'configure', icon: Gauge },
  { name: 'status', label: 'Status', description: 'Show the chat id and active settings', meta: 'info', icon: Database },
  { name: 'mcp', label: 'MCP servers', description: 'View connected MCP servers', meta: 'info', icon: Server },
  { name: 'goal', label: 'Goal', description: 'Set a persistent goal for this chat', meta: 'automation', icon: Target },
  { name: 'permissions', label: 'Permissions', description: 'Choose what Codex can do in this chat', meta: 'access', icon: ShieldCheck },
  { name: 'skills', label: 'Skills', description: 'Choose a skill for your next request', meta: 'configure', icon: Sparkles },
];

function twoDigit(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatMessageTimestamp(date: Date): string {
  return `${date.getFullYear()}.${twoDigit(date.getMonth() + 1)}.${twoDigit(date.getDate())} ${twoDigit(date.getHours())}:${twoDigit(date.getMinutes())}`;
}

function formatItemCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatMcpServerDetail(server: ChatMcpServer): string {
  const version = server.version ? ` · v${server.version}` : '';
  const resources = server.resourceCount + server.resourceTemplateCount;
  return `${server.name}${version} · ${formatItemCount(server.toolCount, 'tool')} · ${formatItemCount(resources, 'resource')}`;
}

export function formatMcpConnectionStatus(server: ChatMcpServer): string {
  const labels = {
    notStarted: 'Not started',
    starting: 'Starting',
    connected: 'Connected',
    authenticationRequired: 'Sign-in required',
    failed: 'Failed',
    cancelled: 'Cancelled',
    disabled: 'Disabled',
  };
  return server.runtimeStatus ? labels[server.runtimeStatus] : 'Status unknown';
}

export function formatMcpAuthStatus(server: ChatMcpServer): string {
  switch (server.authStatus) {
    case 'unsupported': return 'Auth: not applicable';
    case 'notLoggedIn': return 'Auth: not signed in';
    case 'bearerToken': return 'Auth: bearer token';
    case 'oAuth': return 'Auth: OAuth';
    default: return 'Auth: unknown';
  }
}

export function formatGoalUsage(goal: ChatGoal): string {
  const tokenUsage = goal.tokenBudget === null
    ? `${goal.tokensUsed.toLocaleString()} tokens`
    : `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens`;
  return `${tokenUsage} · ${Math.round(goal.timeUsedSeconds)}s`;
}

export function assertFastModeAvailable(configuration: ChatConfiguration): void {
  if (!configuration.fastModeAvailable) {
    throw new Error('Fast mode is not available for the current model.');
  }
}

export function formatReasoningEffort(effort: string): string {
  const labels: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
    ultra: 'Ultra',
  };
  return labels[effort.toLocaleLowerCase()] ?? effort;
}

export function fastTierForModel(model: ChatModel | undefined) {
  return model?.serviceTiers.find((tier) => {
    const id = tier.id.toLocaleLowerCase();
    return id === 'fast' || id === 'priority' || tier.name.toLocaleLowerCase() === 'fast';
  }) ?? null;
}

export function attachmentTypeLabel(name: string): string {
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex <= 0 || extensionIndex === name.length - 1) return 'FILE';
  return name.slice(extensionIndex + 1).toLocaleUpperCase();
}

export function chatCommandMenuTitle(mode: CommandMenuMode | null): string {
  const titles: Partial<Record<CommandMenuMode, string>> = {
    agents: 'AGENT THREADS',
    skills: 'SKILLS',
    models: 'MODELS',
    reasoning: 'REASONING',
    status: 'STATUS',
    mcp: 'MCP SERVERS',
    goal: 'GOAL',
    permissions: 'PERMISSIONS',
  };
  return mode ? titles[mode] ?? 'COMMANDS' : 'COMMANDS';
}

interface ChatCommandMenuCounts {
  agents: number;
  skills: number;
  models: number;
  reasoning: number;
  mcp: number;
  permissions: number;
}

export function chatCommandMenuSubtitle(
  mode: CommandMenuMode | null,
  loading: boolean,
  counts: ChatCommandMenuCounts,
  goal: ChatGoal | null,
  error: string | null = null,
): string {
  if (loading) return 'Loading from Codex';
  if (mode === 'mcp' && error) return 'MCP status unavailable';
  if (mode === 'agents') return `${counts.agents} threads`;
  if (mode === 'skills') return `${counts.skills} available`;
  if (mode === 'models') return `${counts.models} available`;
  if (mode === 'reasoning') return `${counts.reasoning} levels`;
  if (mode === 'status') return 'Current local chat configuration';
  if (mode === 'mcp') return `${counts.mcp} configured`;
  if (mode === 'goal') return goal ? `Current status: ${goal.status}` : 'Set a persistent objective';
  if (mode === 'permissions') return `${counts.permissions} available`;
  return 'Type to filter';
}

export function chatCommandMenuHelp(mode: CommandMenuMode | null): string {
  if (mode === 'goal') return 'Enter Save · Shift Enter New line · Esc Close';
  if (mode === 'mcp') return 'Type to filter · Esc Close';
  if (mode === 'status') return 'Esc Close';
  return '↑↓ Navigate · Enter Select · Esc Close';
}
