import { marketplaceAddRequest, type MarketplaceAddResult } from "../shared/plugin-actions.ts";
import { mcpServersFromListResponse, skillsFromListResponse } from "./codex-chat-catalog.mts";
import {
  codexPluginReference,
  pluginFromReadResponse,
  pluginInstallResultFromResponse,
  pluginLogosFromListResponse,
  pluginsFromListResponse,
} from "./codex-chat-plugins.mts";
import type {
  ChatMcpServer,
  ChatPluginLogoSources,
  ChatPluginSummary,
  ChatSkill,
  CodexChatClient,
  CodexChatLogger,
} from "./codex-chat-types.mts";
import { errorMessage, requiredString } from "./codex-chat-values.mts";
import { recordValue } from "./codex-service-utils.mts";
import { probeCodexMcpServers, type CodexMcpProbeClient } from './codex-mcp-probe.mts';

interface CodexChatCatalogContext {
  client: CodexChatClient;
  createMcpProbeClient?: () => CodexMcpProbeClient;
  cwd: string;
  log: CodexChatLogger;
  viewedThreadId: string | null;
  subscribedThreadIds: Set<string>;
  availableSkills: Map<string, ChatSkill>;
  availablePluginLogos: Map<string, ChatPluginLogoSources>;
  listSkills(): Promise<{ skills: ChatSkill[] }>;
  refreshPluginSkills(operation: "install" | "uninstall"): Promise<boolean>;
}

/** @returns {Promise<{ skills: ChatSkill[] }>} */
export async function listCodexSkills(context: CodexChatCatalogContext): Promise<{ skills: ChatSkill[] }> {
  // Plugin discovery initializes skill roots in this App Server process.
  // Reloading skills alone does not discover newly installed plugin roots.
  await listCodexPlugins(context, false);
  const raw = await context.client.request("skills/list", {
    cwds: [context.cwd],
    forceReload: true,
  });
  const skills = skillsFromListResponse(raw, context.cwd);
  context.availableSkills = new Map(skills.map((skill) => [skill.path, skill]));
  return { skills };
}

/**
 * @param {unknown} [forceRefetch]
 * @returns {Promise<{ plugins: ChatPluginSummary[], featuredPluginIds: string[], marketplaceErrors: Array<{ marketplacePath: string, message: string }> }>}
 */
export async function listCodexPlugins(context: CodexChatCatalogContext, forceRefetch: unknown = false): Promise<{
    plugins: ChatPluginSummary[];
    featuredPluginIds: string[];
    marketplaceErrors: Array<{ marketplacePath: string; message: string }>;
  }> {
  if (typeof forceRefetch !== "boolean") {
    throw new TypeError("Plugin refresh flag must be a boolean.");
  }
  const raw = await context.client.request("plugin/list", {
    cwds: [context.cwd],
    forceRefetch,
  });
  const plugins = pluginsFromListResponse(raw);
  context.availablePluginLogos = pluginLogosFromListResponse(raw);
  return plugins;
}

/**
 * @param {unknown} pluginId
 * @returns {ChatPluginLogoSources | null}
 */
export function getCodexPluginLogoSources(context: CodexChatCatalogContext, pluginId: unknown): ChatPluginLogoSources | null {
  const id = requiredString(pluginId, "Plugin id");
  return context.availablePluginLogos.get(id) ?? null;
}

/**
 * @param {unknown} reference
 */
export async function readCodexPlugin(context: CodexChatCatalogContext, reference: unknown) {
  return pluginFromReadResponse(
    await context.client.request("plugin/read", codexPluginReference(reference)),
  );
}

export async function addCodexMarketplace(context: CodexChatCatalogContext, value: unknown): Promise<MarketplaceAddResult> {
  const request = marketplaceAddRequest(value);
  const result = recordValue(await context.client.request('marketplace/add', request, 120_000));
  if (!result || (result.alreadyAdded !== true && result.alreadyAdded !== false)) {
    throw new TypeError('The marketplace registration response is invalid.');
  }
  return {
    marketplaceName: requiredString(result.marketplaceName, 'Marketplace name'),
    installedRoot: requiredString(result.installedRoot, 'Marketplace root'),
    alreadyAdded: result.alreadyAdded,
  };
}

/**
 * @param {unknown} reference
 * @returns {Promise<{ appsNeedingAuth: Array<{ id: string, name: string, description: string, category: string, installUrl: string | null }>, authPolicy: string, runtimeRefreshed: boolean }>}
 */
export async function installCodexPlugin(context: CodexChatCatalogContext, reference: unknown): Promise<{
    appsNeedingAuth: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      installUrl: string | null;
    }>;
    authPolicy: string;
    runtimeRefreshed: boolean;
  }> {
  const result = pluginInstallResultFromResponse(
    await context.client.request(
      "plugin/install",
      codexPluginReference(reference),
    ),
  );
  return {
    ...result,
    runtimeRefreshed: await context.refreshPluginSkills("install"),
  };
}

/**
 * @param {unknown} pluginId
 * @returns {Promise<{ runtimeRefreshed: boolean }>}
 */
export async function uninstallCodexPlugin(context: CodexChatCatalogContext, pluginId: unknown): Promise<{ runtimeRefreshed: boolean }> {
  const id = requiredString(pluginId, "Plugin id");
  await context.client.request("plugin/uninstall", { pluginId: id });
  return { runtimeRefreshed: await context.refreshPluginSkills("uninstall") };
}

/**
 * @param {'install' | 'uninstall'} operation
 * @returns {Promise<boolean>}
 */
export async function refreshCodexPluginSkills(context: CodexChatCatalogContext, operation: "install" | "uninstall"): Promise<boolean> {
  try {
    await context.listSkills();
    return true;
  } catch (error) {
    context.log("codex-plugin-skills-refresh-failed", {
      operation,
      message: errorMessage(error),
    });
    return false;
  }
}

/** @returns {Promise<{ servers: ChatMcpServer[] }>} */
export async function listCodexMcpServers(context: CodexChatCatalogContext): Promise<{ servers: ChatMcpServer[] }> {
  const viewedThreadId = context.viewedThreadId;
  // Reading stored history does not load a thread into the App Server runtime.
  const threadId = viewedThreadId && context.subscribedThreadIds.has(viewedThreadId) ? viewedThreadId : null;
  if (!threadId) return probeCodexMcpServers(context);
  const params = {
    limit: 100,
    detail: "toolsAndAuthOnly",
    threadId,
  };
  try {
    return { servers: mcpServersFromListResponse(await context.client.request("mcpServerStatus/list", params)) };
  } catch (error) {
    if (!threadId || !isMissingMcpThread(error, threadId)) throw error;
    // A previously loaded thread may have closed before the status request.
    context.subscribedThreadIds.delete(threadId);
    return probeCodexMcpServers(context);
  }
}

function isMissingMcpThread(error: unknown, threadId: string): boolean {
  return error instanceof Error && error.name === "CodexRequestRejectedError"
    && error.message === `thread not found: ${threadId}`;
}
