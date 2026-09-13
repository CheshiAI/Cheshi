import type { ChatMcpRuntimeStatus } from '../shared/chat-mcp-status.ts';

export type ChatCollaborationMode = 'default' | 'plan';

export type ApprovalDecision = "accept" | "acceptForSession" | "decline";

export type JsonObject = Record<string, unknown>;

export interface ChatAgentThread {
  id: string;
  parentThreadId: string | null;
  title: string;
  description: string;
  kind: "main" | "subagent";
  role: string | null;
  depth: number;
  status: string;
  current: boolean;
}

export interface ChatSkill {
  name: string;
  displayName: string;
  description: string;
  scope: "user" | "repo" | "system" | "admin";
  path: string;
}

export interface ChatAttachment {
  kind: "image" | "file";
  name: string;
  path: string;
}

interface ChatReasoningEffort {
  effort: string;
  description: string;
}

export interface ChatServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface ChatModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ChatReasoningEffort[];
  serviceTiers: ChatServiceTier[];
  defaultServiceTier: string | null;
}

export interface ChatMcpServer {
  name: string;
  displayName: string;
  version: string | null;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
  authStatus: string;
  runtimeStatus: ChatMcpRuntimeStatus | null;
  toolsError: string | null;
  connected: boolean;
}

export interface CodexPluginReference {
  pluginName: string;
  marketplacePath?: string;
  remoteMarketplaceName?: string;
}

export interface ChatPluginSummary {
  id: string;
  name: string;
  displayName: string;
  shortDescription: string;
  longDescription: string;
  developerName: string;
  category: string;
  capabilities: string[];
  keywords: string[];
  defaultPrompts: string[];
  brandColor: string | null;
  hasLogo: boolean;
  installed: boolean;
  enabled: boolean;
  installPolicy: string;
  authPolicy: string;
  availability: string;
  disabledReason: string | null;
  source: string;
  version: string | null;
  localVersion: string | null;
  marketplaceName: string;
  marketplaceDisplayName: string;
  reference: CodexPluginReference;
}

export type ChatPluginSkill = {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
};

export type ChatPluginApp = {
  id: string;
  name: string;
  description: string;
  category: string;
  installUrl: string | null;
};

export type ChatPluginAppTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
};

export type ChatPluginHook = { key: string; eventName: string };

export type ChatPluginScheduledTask = { key: string; name: string; prompt: string };

export type ChatPluginDetail = ChatPluginSummary & {
  description: string;
  shareUrl: string | null;
  skills: ChatPluginSkill[];
  apps: ChatPluginApp[];
  appTemplates: ChatPluginAppTemplate[];
  mcpServers: string[];
  hooks: ChatPluginHook[];
  scheduledTasks: ChatPluginScheduledTask[];
};

export type ChatPluginLogoSource = { kind: "local" | "remote"; value: string };

export type ChatPluginLogoSources = {
  light: ChatPluginLogoSource | null;
  dark: ChatPluginLogoSource | null;
};

export interface ChatGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

export interface ChatPermissionMode {
  id: string;
  profileId: string;
  label: string;
  description: string;
  access: string;
  allowed: boolean;
  dangerous: boolean;
}

export interface PermissionModeDefinition {
  id: string;
  profileId: string;
  label: string;
  description: string;
  access: string;
  dangerous: boolean;
}

export interface PermissionProfileSummary {
  id: string;
  description: string | null;
  allowed: boolean;
}

export interface ChatApprovalRequest {
  id: string;
  threadId: string;
  kind: "command" | "fileChange" | "permissions";
  title: string;
  detail: string;
  canAllowForSession: boolean;
}

export interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  clientMessageId: string;
  deltaItemIds: Set<string>;
  commands: Map<string, { processId: string | null; completed: boolean }>;
  interruptRequested: boolean;
  startedEmitted: boolean;
}

export interface CodexChatClient {
  request: (
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ) => Promise<unknown>;
  respond: (id: string | number, result: unknown) => Promise<void>;
  onNotification: (listener: (value: JsonObject) => void) => () => void;
  onRequest: (listener: (value: JsonObject) => void) => () => void;
  onDidFail: (listener: (error: Error) => void) => () => void;
}

export type CodexChatLogger = (event: string, details: JsonObject) => void;
