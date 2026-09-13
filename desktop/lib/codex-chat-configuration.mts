import {
  fastServiceTier,
  isFastServiceTier,
  modelsFromListResponse,
} from "./codex-chat-catalog.mts";
import {
  DEFAULT_PERMISSION_MODE_ID,
  defaultPermissionMode,
  permissionModeSettings,
  permissionModesFromListResponse,
} from "./codex-chat-permissions.mts";
import type {
  ChatModel,
  ChatCollaborationMode,
  ChatPermissionMode,
  CodexChatClient,
  JsonObject,
} from "./codex-chat-types.mts";
import { requiredString } from "./codex-chat-values.mts";
import { recordValue } from "./codex-service-utils.mts";

interface CodexChatConfigurationContext {
  client: CodexChatClient;
  cwd: string;
  availableModels: Map<string, ChatModel>;
  selectedModel: string | null;
  selectedCollaborationMode: ChatCollaborationMode;
  selectedReasoningEffort: string;
  selectedServiceTier: string | null | undefined;
  permissionModes: Map<string, ChatPermissionMode>;
  permissionModesLoaded: boolean;
  selectedPermissionModeId: string;
  viewedThreadId: string | null;
  subscribedThreadIds: Set<string>;
  listModels(): Promise<{ models: ChatModel[]; configuration: JsonObject }>;
  listPermissionModes(): Promise<{ modes: ChatPermissionMode[]; currentMode: ChatPermissionMode }>;
  currentModel(): ChatModel | null;
  currentPermissionMode(): ChatPermissionMode;
  currentServiceTier(): string | null;
  ensureReasoningEffortIsSupported(): void;
  ensureServiceTierIsSupported(): void;
  configuration(): JsonObject;
  isThreadActive(threadId: string | null): boolean;
  emit(event: JsonObject): void;
}

/** @returns {Promise<{ models: ChatModel[], configuration: JsonObject }>} */
export async function listCodexModels(context: CodexChatConfigurationContext): Promise<{
    models: ChatModel[];
    configuration: JsonObject;
  }> {
  const raw = await context.client.request("model/list", {
    limit: 100,
    includeHidden: false,
  });
  const models = modelsFromListResponse(raw);
  context.availableModels = new Map(models.map((model) => [model.model, model]));
  if (context.selectedModel && !context.availableModels.has(context.selectedModel))
    context.selectedModel = null;
  context.ensureReasoningEffortIsSupported();
  context.ensureServiceTierIsSupported();
  return { models, configuration: context.configuration() };
}

/** @returns {Promise<{ modes: ChatPermissionMode[], currentMode: ChatPermissionMode }>} */
export async function listCodexPermissionModes(context: CodexChatConfigurationContext): Promise<{
    modes: ChatPermissionMode[];
    currentMode: ChatPermissionMode;
  }> {
  const raw = await context.client.request("permissionProfile/list", {
    limit: 100,
    cwd: context.cwd,
  });
  const modes = permissionModesFromListResponse(raw);
  context.permissionModes = new Map(modes.map((mode) => [mode.id, mode]));
  context.permissionModesLoaded = true;
  const currentMode = context.currentPermissionMode();
  return { modes, currentMode };
}

/**
 * @param {unknown} modeId
 * @returns {Promise<{ mode: ChatPermissionMode }>}
 */
export async function setCodexPermissionMode(context: CodexChatConfigurationContext, modeId: unknown): Promise<{ mode: ChatPermissionMode }> {
  if (context.isThreadActive(context.viewedThreadId))
    throw new Error("A response is already in progress for this chat.");
  const id = requiredString(modeId, "Permission mode");
  if (!context.permissionModesLoaded) await context.listPermissionModes();
  const mode = context.permissionModes.get(id);
  if (!mode)
    throw new Error(
      "The selected Codex permission mode is no longer available.",
    );
  if (!mode.allowed)
    throw new Error("The selected Codex permission mode is not allowed.");

  const previousModeId = context.selectedPermissionModeId;
  context.selectedPermissionModeId = mode.id;
  try {
    if (
      context.viewedThreadId &&
      context.subscribedThreadIds.has(context.viewedThreadId)
    ) {
      await context.client.request("thread/settings/update", {
        threadId: context.viewedThreadId,
        ...permissionModeSettings(mode),
      });
    }
  } catch (error) {
    context.selectedPermissionModeId = previousModeId;
    throw error;
  }
  context.emit({ type: "permission-mode-changed", mode });
  return { mode };
}

/**
 * @param {unknown} value
 * @returns {Promise<JsonObject>}
 */
export async function configureCodexChat(context: CodexChatConfigurationContext, value: unknown): Promise<JsonObject> {
  const options = recordValue(value);
  if (!options) throw new TypeError("Chat configuration must be an object.");
  if (context.availableModels.size === 0) await context.listModels();

  if (Object.hasOwn(options, "model")) {
    const model = requiredString(options.model, "Chat model");
    if (!context.availableModels.has(model))
      throw new Error("The selected Codex model is no longer available.");
    context.selectedModel = model;
    context.ensureReasoningEffortIsSupported();
    context.ensureServiceTierIsSupported();
  }

  if (Object.hasOwn(options, "effort")) {
    const effort = requiredString(options.effort, "Reasoning effort");
    const activeModel = context.currentModel();
    if (
      !activeModel?.supportedReasoningEfforts.some(
        (option) => option.effort === effort,
      )
    ) {
      throw new Error(
        "The selected reasoning effort is not supported by the current model.",
      );
    }
    context.selectedReasoningEffort = effort;
  }

  if (Object.hasOwn(options, "fast")) {
    if (options.fast !== true && options.fast !== false) {
      throw new TypeError("Fast mode must be a boolean.");
    }
    if (options.fast) {
      const tier = fastServiceTier(context.currentModel());
      if (!tier)
        throw new Error("Fast mode is not available for the current model.");
      context.selectedServiceTier = tier.id;
    } else {
      context.selectedServiceTier = null;
    }
  }

  if (
    !Object.hasOwn(options, "model") &&
    !Object.hasOwn(options, "effort") &&
    !Object.hasOwn(options, "fast")
  ) {
    throw new TypeError(
      "Chat configuration must include a model, reasoning effort, or Fast mode setting.",
    );
  }
  return context.configuration();
}

/** @returns {ChatPermissionMode} */
export function currentCodexPermissionMode(context: CodexChatConfigurationContext): ChatPermissionMode {
  return (
    context.permissionModes.get(context.selectedPermissionModeId) ??
    defaultPermissionMode()
  );
}

/** @returns {JsonObject} */
export function codexPermissionOverrides(context: CodexChatConfigurationContext): JsonObject {
  return permissionModeSettings(context.currentPermissionMode());
}

export function resetCodexPermissionMode(context: CodexChatConfigurationContext) {
  context.selectedPermissionModeId = DEFAULT_PERMISSION_MODE_ID;
  context.emit({
    type: "permission-mode-changed",
    mode: context.currentPermissionMode(),
  });
}

/** @returns {ChatModel | null} */
export function currentCodexModel(context: CodexChatConfigurationContext): ChatModel | null {
  if (context.selectedModel)
    return context.availableModels.get(context.selectedModel) ?? null;
  return (
    [...context.availableModels.values()].find((model) => model.isDefault) ??
    context.availableModels.values().next().value ??
    null
  );
}

export function ensureCodexReasoningEffortIsSupported(context: CodexChatConfigurationContext) {
  const activeModel = context.currentModel();
  if (!activeModel) return;
  if (
    activeModel.supportedReasoningEfforts.some(
      (option) => option.effort === context.selectedReasoningEffort,
    )
  )
    return;
  context.selectedReasoningEffort = activeModel.defaultReasoningEffort;
}

export function ensureCodexServiceTierIsSupported(context: CodexChatConfigurationContext) {
  if (
    context.selectedServiceTier === undefined ||
    context.selectedServiceTier === null
  )
    return;
  const activeModel = context.currentModel();
  if (!activeModel) return;
  if (
    activeModel.serviceTiers.some(
      (tier) => tier.id === context.selectedServiceTier,
    )
  )
    return;
  context.selectedServiceTier = isFastServiceTier(null, context.selectedServiceTier)
    ? fastServiceTier(activeModel)?.id
    : undefined;
}

/** @returns {string | null} */
export function currentCodexServiceTier(context: CodexChatConfigurationContext): string | null {
  if (context.selectedServiceTier !== undefined) return context.selectedServiceTier;
  return context.currentModel()?.defaultServiceTier ?? null;
}

/** @returns {JsonObject} */
export function codexServiceTierOverride(context: CodexChatConfigurationContext): JsonObject {
  return context.selectedServiceTier === undefined
    ? {}
    : { serviceTier: context.selectedServiceTier };
}

/** @returns {JsonObject} */
export function codexChatConfiguration(context: CodexChatConfigurationContext): JsonObject {
  const activeModel = context.currentModel();
  const serviceTier = context.currentServiceTier();
  const activeServiceTier =
    activeModel?.serviceTiers.find((tier) => tier.id === serviceTier) ?? null;
  const fastTier = fastServiceTier(activeModel);
  return {
    collaborationMode: context.selectedCollaborationMode,
    model: activeModel?.model ?? null,
    modelDisplayName: activeModel?.displayName ?? "Default model",
    reasoningEffort: context.selectedReasoningEffort,
    supportedReasoningEfforts: activeModel?.supportedReasoningEfforts ?? [],
    serviceTier,
    serviceTierDisplayName:
      activeServiceTier?.name ?? serviceTier ?? "Standard",
    fastModeAvailable: fastTier !== null,
    fastModeEnabled:
      fastTier !== null && isFastServiceTier(activeModel, serviceTier),
  };
}
