import type { ChatMcpServer, ChatModel, ChatServiceTier, ChatSkill } from "./codex-chat-types.mts";
import { recordValue, stringValue } from "./codex-service-utils.mts";
import { normalizeMcpRuntimeStatus } from '../shared/chat-mcp-status.ts';

const SKILL_SCOPE_ORDER = new Map([
  ["user", 0],
  ["repo", 1],
  ["system", 2],
  ["admin", 3],
]);

export const DEFAULT_REASONING_EFFORT = "medium";

const MCP_AUTH_STATUSES = new Set([
  "unknown",
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
]);

/**
 * @param {unknown} value
 * @returns {'user' | 'repo' | 'system' | 'admin' | null}
 */
function skillScope(
  value: unknown,
): "user" | "repo" | "system" | "admin" | null {
  if (
    value === "user" ||
    value === "repo" ||
    value === "system" ||
    value === "admin"
  )
    return value;
  return null;
}

/**
 * @param {unknown} value
 * @returns {ChatSkill | null}
 */
function chatSkillFromValue(value: unknown): ChatSkill | null {
  const skill = recordValue(value);
  const name = stringValue(skill?.name)?.trim();
  const path = stringValue(skill?.path)?.trim();
  const scope = skillScope(skill?.scope);
  if (!skill || !name || !path || !scope || skill.enabled !== true) return null;

  const skillInterface = recordValue(skill.interface);
  return {
    name,
    displayName: stringValue(skillInterface?.displayName)?.trim() || name,
    description:
      stringValue(skillInterface?.shortDescription)?.trim() ||
      stringValue(skill.shortDescription)?.trim() ||
      stringValue(skill.description)?.trim() ||
      "",
    scope,
    path,
  };
}

/**
 * @param {unknown} value
 * @returns {ChatServiceTier | null}
 */
function chatServiceTierFromValue(value: unknown): ChatServiceTier | null {
  const tier = recordValue(value);
  const id = stringValue(tier?.id)?.trim();
  const name = stringValue(tier?.name)?.trim();
  if (!tier || !id || !name) return null;
  return {
    id,
    name,
    description: stringValue(tier.description)?.trim() || name,
  };
}

/**
 * @param {ChatModel | null} model
 * @returns {ChatServiceTier | null}
 */
export function fastServiceTier(model: ChatModel | null): ChatServiceTier | null {
  if (!model) return null;
  return (
    model.serviceTiers.find((tier) => tier.id.toLocaleLowerCase() === "fast") ??
    model.serviceTiers.find(
      (tier) => tier.name.toLocaleLowerCase() === "fast",
    ) ??
    model.serviceTiers.find(
      (tier) => tier.id.toLocaleLowerCase() === "priority",
    ) ??
    null
  );
}

/**
 * @param {ChatModel | null} model
 * @param {string | null} serviceTier
 * @returns {boolean}
 */
export function isFastServiceTier(
  model: ChatModel | null,
  serviceTier: string | null,
): boolean {
  if (!serviceTier) return false;
  const normalizedTier = serviceTier.toLocaleLowerCase();
  if (normalizedTier === "fast" || normalizedTier === "priority") return true;
  return (
    model?.serviceTiers.some(
      (tier) =>
        tier.id === serviceTier && tier.name.toLocaleLowerCase() === "fast",
    ) === true
  );
}

/**
 * @param {unknown} value
 * @param {string} cwd
 * @returns {ChatSkill[]}
 */
export function skillsFromListResponse(
  value: unknown,
  cwd: string,
): ChatSkill[] {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.data)) {
    throw new Error("The Codex skills response format is invalid.");
  }

  const entries = response.data.map(recordValue).filter(Boolean);
  const matchingEntries = entries.filter(
    (entry) => stringValue(entry?.cwd) === cwd,
  );
  const scopedEntries =
    matchingEntries.length > 0
      ? matchingEntries
      : entries.length === 1
        ? entries
        : [];
  /** @type {Map<string, ChatSkill>} */
  const skillsByPath: Map<string, ChatSkill> = new Map();

  for (const entry of scopedEntries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const value of entry.skills) {
      const skill = chatSkillFromValue(value);
      if (skill) skillsByPath.set(skill.path, skill);
    }
  }

  return [...skillsByPath.values()].sort((left, right) => {
    const scopeDifference =
      (SKILL_SCOPE_ORDER.get(left.scope) ?? 4) -
      (SKILL_SCOPE_ORDER.get(right.scope) ?? 4);
    if (scopeDifference !== 0) return scopeDifference;
    return left.displayName.localeCompare(right.displayName, undefined, {
      sensitivity: "base",
    });
  });
}

/**
 * @param {unknown} value
 * @returns {ChatModel | null}
 */
function chatModelFromValue(value: unknown): ChatModel | null {
  const model = recordValue(value);
  const id = stringValue(model?.id)?.trim();
  const modelName = stringValue(model?.model)?.trim();
  const displayName = stringValue(model?.displayName)?.trim();
  const defaultReasoningEffort = stringValue(
    model?.defaultReasoningEffort,
  )?.trim();
  if (
    !model ||
    !id ||
    !modelName ||
    !displayName ||
    !defaultReasoningEffort ||
    model.hidden === true
  )
    return null;

  const supportedReasoningEfforts = Array.isArray(
    model.supportedReasoningEfforts,
  )
    ? model.supportedReasoningEfforts.flatMap((optionValue) => {
        const option = recordValue(optionValue);
        const effort = stringValue(option?.reasoningEffort)?.trim();
        if (!option || !effort) return [];
        return [
          {
            effort,
            description: stringValue(option.description)?.trim() || effort,
          },
        ];
      })
    : [];

  if (
    !supportedReasoningEfforts.some(
      (option) => option.effort === defaultReasoningEffort,
    )
  ) {
    supportedReasoningEfforts.push({
      effort: defaultReasoningEffort,
      description: `${displayName} default`,
    });
  }

  /** @type {Map<string, ChatServiceTier>} */
  const serviceTiersById: Map<string, ChatServiceTier> = new Map();
  if (Array.isArray(model.serviceTiers)) {
    for (const value of model.serviceTiers) {
      const tier = chatServiceTierFromValue(value);
      if (tier) serviceTiersById.set(tier.id, tier);
    }
  }
  if (Array.isArray(model.additionalSpeedTiers)) {
    for (const value of model.additionalSpeedTiers) {
      const id = stringValue(value)?.trim();
      if (!id || serviceTiersById.has(id)) continue;
      serviceTiersById.set(id, {
        id,
        name: id.toLocaleLowerCase() === "priority" ? "Fast" : id,
        description: id,
      });
    }
  }

  return {
    id,
    model: modelName,
    displayName,
    description: stringValue(model.description)?.trim() || modelName,
    isDefault: model.isDefault === true,
    defaultReasoningEffort,
    supportedReasoningEfforts,
    serviceTiers: [...serviceTiersById.values()],
    defaultServiceTier: stringValue(model.defaultServiceTier)?.trim() || null,
  };
}

/**
 * @param {unknown} value
 * @returns {ChatModel[]}
 */
export function modelsFromListResponse(value: unknown): ChatModel[] {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.data)) {
    throw new Error("The Codex model list response format is invalid.");
  }
  return response.data.flatMap((value) => {
    const model = chatModelFromValue(value);
    return model ? [model] : [];
  });
}

/**
 * @param {unknown} value
 * @returns {ChatMcpServer | null}
 */
function chatMcpServerFromValue(value: unknown): ChatMcpServer | null {
  const server = recordValue(value);
  const name = stringValue(server?.name)?.trim();
  if (!server || !name) return null;
  const serverInfo = recordValue(server.serverInfo);
  const displayName = stringValue(serverInfo?.title)?.trim() || stringValue(serverInfo?.name)?.trim() || name;
  const authStatus = stringValue(server.authStatus);
  // Older app servers expose only serverInfo. Explicit runtime state takes
  // precedence because serverInfo may be cached after the connection closes.
  const runtimeStatus = server.runtimeStatus === undefined
    ? serverInfo !== null ? 'connected' : null
    : normalizeMcpRuntimeStatus(server.runtimeStatus);
  return {
    name,
    displayName: displayName.toLowerCase() === 'rmcp' ? name : displayName,
    version: stringValue(serverInfo?.version)?.trim() || null,
    toolCount: Object.keys(recordValue(server.tools) ?? {}).length,
    resourceCount: Array.isArray(server.resources)
      ? server.resources.length
      : 0,
    resourceTemplateCount: Array.isArray(server.resourceTemplates)
      ? server.resourceTemplates.length
      : 0,
    authStatus:
      authStatus && MCP_AUTH_STATUSES.has(authStatus) ? authStatus : "unknown",
    runtimeStatus,
    toolsError: stringValue(server.toolsError)?.trim() || null,
    connected: runtimeStatus === 'connected',
  };
}

/**
 * @param {unknown} value
 * @returns {ChatMcpServer[]}
 */
export function mcpServersFromListResponse(value: unknown): ChatMcpServer[] {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.data)) {
    throw new Error("The Codex MCP server status response format is invalid.");
  }
  return response.data.flatMap((value) => {
    const server = chatMcpServerFromValue(value);
    return server ? [server] : [];
  });
}
