import type {
  ChatPluginApp,
  ChatPluginAppTemplate,
  ChatPluginDetail,
  ChatPluginHook,
  ChatPluginLogoSource,
  ChatPluginLogoSources,
  ChatPluginScheduledTask,
  ChatPluginSkill,
  ChatPluginSummary,
  CodexPluginReference,
} from "./codex-chat-types.mts";
import { requiredString, stringList } from "./codex-chat-values.mts";
import { recordValue, stringValue } from "./codex-service-utils.mts";

const PLUGIN_SOURCE_TYPES = new Set(["local", "git", "npm", "remote"]);

/**
 * @param {unknown} value
 * @returns {CodexPluginReference}
 */
export function codexPluginReference(value: unknown): CodexPluginReference {
  const reference = recordValue(value);
  if (!reference) throw new TypeError("Plugin reference must be an object.");
  const pluginName = requiredString(reference.pluginName, "Plugin name");
  const marketplacePath =
    stringValue(reference.marketplacePath)?.trim() || null;
  const remoteMarketplaceName =
    stringValue(reference.remoteMarketplaceName)?.trim() || null;
  if ((marketplacePath === null) === (remoteMarketplaceName === null)) {
    throw new TypeError(
      "Plugin reference must identify exactly one marketplace.",
    );
  }
  if (marketplacePath) return { pluginName, marketplacePath };
  if (remoteMarketplaceName) return { pluginName, remoteMarketplaceName };
  throw new TypeError("Plugin reference must identify a marketplace.");
}

/**
 * @param {unknown} value
 * @returns {ChatPluginLogoSource | null}
 */
function chatPluginLogoSource(value: unknown): ChatPluginLogoSource | null {
  const source = stringValue(value)?.trim();
  if (!source) return null;
  if (source.startsWith("/")) return { kind: "local", value: source };
  try {
    const url = new URL(source);
    return url.protocol === "https:"
      ? { kind: "remote", value: url.href }
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {ChatPluginLogoSources}
 */
function chatPluginLogoSources(value: unknown): ChatPluginLogoSources {
  const pluginInterface = recordValue(value);
  const light =
    chatPluginLogoSource(pluginInterface?.logo) ??
    chatPluginLogoSource(pluginInterface?.logoUrl) ??
    chatPluginLogoSource(pluginInterface?.composerIcon) ??
    chatPluginLogoSource(pluginInterface?.composerIconUrl);
  const dark =
    chatPluginLogoSource(pluginInterface?.logoDark) ??
    chatPluginLogoSource(pluginInterface?.logoUrlDark);
  return { light: light ?? dark, dark };
}

/**
 * @param {unknown} value
 * @returns {Map<string, ChatPluginLogoSources>}
 */
export function pluginLogosFromListResponse(
  value: unknown,
): Map<string, ChatPluginLogoSources> {
  const response = recordValue(value);
  /** @type {Map<string, { installed: boolean, sources: ChatPluginLogoSources }>} */
  const logosById: Map<
    string,
    { installed: boolean; sources: ChatPluginLogoSources }
  > = new Map();
  if (!response || !Array.isArray(response.marketplaces)) return new Map();
  for (const marketplaceValue of response.marketplaces) {
    const marketplace = recordValue(marketplaceValue);
    if (!marketplace || !Array.isArray(marketplace.plugins)) continue;
    for (const pluginValue of marketplace.plugins) {
      const plugin = recordValue(pluginValue);
      const id = stringValue(plugin?.id)?.trim();
      if (!plugin || !id) continue;
      const sources = chatPluginLogoSources(plugin.interface);
      if (!sources.light) continue;
      const installed = plugin.installed === true;
      const previous = logosById.get(id);
      if (!previous || (!previous.installed && installed))
        logosById.set(id, { installed, sources });
    }
  }
  return new Map([...logosById].map(([id, { sources }]) => [id, sources]));
}

/**
 * @param {unknown} value
 * @param {{ name: string, displayName: string, path: string | null }} marketplace
 * @returns {ChatPluginSummary | null}
 */
function chatPluginSummaryFromValue(
  value: unknown,
  marketplace: { name: string; displayName: string; path: string | null },
): ChatPluginSummary | null {
  const plugin = recordValue(value);
  const id = stringValue(plugin?.id)?.trim();
  const name = stringValue(plugin?.name)?.trim();
  const remotePluginId = stringValue(plugin?.remotePluginId)?.trim();
  const referenceName = marketplace.path ? name : remotePluginId;
  const installPolicy = stringValue(plugin?.installPolicy)?.trim();
  const authPolicy = stringValue(plugin?.authPolicy)?.trim();
  const source = stringValue(recordValue(plugin?.source)?.type)?.trim();
  if (
    !plugin ||
    !id ||
    !name ||
    !referenceName ||
    !installPolicy ||
    !authPolicy ||
    !source ||
    !PLUGIN_SOURCE_TYPES.has(source)
  ) {
    return null;
  }

  const pluginInterface = recordValue(plugin.interface);
  const logoSources = chatPluginLogoSources(pluginInterface);
  const displayName = stringValue(pluginInterface?.displayName)?.trim() || name;
  const shortDescription =
    stringValue(pluginInterface?.shortDescription)?.trim() || "";
  return {
    id,
    name,
    displayName,
    shortDescription,
    longDescription:
      stringValue(pluginInterface?.longDescription)?.trim() || shortDescription,
    developerName:
      stringValue(pluginInterface?.developerName)?.trim() ||
      marketplace.displayName,
    category: stringValue(pluginInterface?.category)?.trim() || "Tools",
    capabilities: stringList(pluginInterface?.capabilities),
    keywords: stringList(plugin.keywords),
    defaultPrompts: stringList(pluginInterface?.defaultPrompt),
    brandColor: stringValue(pluginInterface?.brandColor)?.trim() || null,
    hasLogo: logoSources.light !== null,
    installed: plugin.installed === true,
    enabled: plugin.enabled === true,
    installPolicy,
    authPolicy,
    availability: stringValue(plugin.availability)?.trim() || "AVAILABLE",
    disabledReason: stringValue(plugin.disabledReason)?.trim() || null,
    source,
    version: stringValue(plugin.version)?.trim() || null,
    localVersion: stringValue(plugin.localVersion)?.trim() || null,
    marketplaceName: marketplace.name,
    marketplaceDisplayName: marketplace.displayName,
    reference: marketplace.path
      ? { pluginName: name, marketplacePath: marketplace.path }
      : { pluginName: referenceName, remoteMarketplaceName: marketplace.name },
  };
}

/**
 * @param {unknown} value
 * @returns {{ plugins: ChatPluginSummary[], featuredPluginIds: string[], marketplaceErrors: Array<{ marketplacePath: string, message: string }> }}
 */
export function pluginsFromListResponse(value: unknown): {
  plugins: ChatPluginSummary[];
  featuredPluginIds: string[];
  marketplaceErrors: Array<{ marketplacePath: string; message: string }>;
} {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.marketplaces)) {
    throw new Error("The Codex plugin list response format is invalid.");
  }

  /** @type {Map<string, ChatPluginSummary>} */
  const pluginsById: Map<string, ChatPluginSummary> = new Map();
  for (const marketplaceValue of response.marketplaces) {
    const marketplace = recordValue(marketplaceValue);
    const name = stringValue(marketplace?.name)?.trim();
    if (!marketplace || !name || !Array.isArray(marketplace.plugins)) continue;
    const marketplaceInterface = recordValue(marketplace.interface);
    const descriptor = {
      name,
      displayName:
        stringValue(marketplaceInterface?.displayName)?.trim() || name,
      path: stringValue(marketplace.path)?.trim() || null,
    };
    for (const pluginValue of marketplace.plugins) {
      const plugin = chatPluginSummaryFromValue(pluginValue, descriptor);
      if (!plugin) continue;
      const previous = pluginsById.get(plugin.id);
      if (!previous || (!previous.installed && plugin.installed))
        pluginsById.set(plugin.id, plugin);
    }
  }

  const marketplaceErrors = Array.isArray(response.marketplaceLoadErrors)
    ? response.marketplaceLoadErrors.flatMap((errorValue) => {
        const error = recordValue(errorValue);
        const marketplacePath = stringValue(error?.marketplacePath)?.trim();
        const message = stringValue(error?.message)?.trim();
        return marketplacePath && message ? [{ marketplacePath, message }] : [];
      })
    : [];
  return {
    plugins: [...pluginsById.values()],
    featuredPluginIds: stringList(response.featuredPluginIds),
    marketplaceErrors,
  };
}

/**
 * @param {unknown} value
 * @returns {ChatPluginApp | null}
 */
function chatPluginAppFromValue(value: unknown): ChatPluginApp | null {
  const app = recordValue(value);
  const id = stringValue(app?.id)?.trim();
  const name = stringValue(app?.name)?.trim();
  if (!app || !id || !name) return null;
  return {
    id,
    name,
    description: stringValue(app.description)?.trim() || "",
    category: stringValue(app.category)?.trim() || "App",
    installUrl: stringValue(app.installUrl)?.trim() || null,
  };
}

/**
 * @param {unknown} value
 * @returns {{ plugin: ChatPluginDetail }}
 */
export function pluginFromReadResponse(value: unknown): {
  plugin: ChatPluginDetail;
} {
  const response = recordValue(value);
  const detail = recordValue(response?.plugin);
  const marketplaceName = stringValue(detail?.marketplaceName)?.trim();
  const summary = recordValue(detail?.summary);
  if (!response || !detail || !marketplaceName || !summary) {
    throw new Error("The Codex plugin detail response format is invalid.");
  }
  const plugin = chatPluginSummaryFromValue(summary, {
    name: marketplaceName,
    displayName: marketplaceName,
    path: stringValue(detail.marketplacePath)?.trim() || null,
  });
  if (!plugin)
    throw new Error("The Codex plugin detail response format is invalid.");

  /** @type {ChatPluginSkill[]} */
  const skills: ChatPluginSkill[] = Array.isArray(detail.skills)
    ? detail.skills.flatMap((skillValue) => {
        const skill = recordValue(skillValue);
        const name = stringValue(skill?.name)?.trim();
        if (!skill || !name) return [];
        const skillInterface = recordValue(skill.interface);
        return [
          {
            name,
            displayName:
              stringValue(skillInterface?.displayName)?.trim() || name,
            description:
              stringValue(skillInterface?.shortDescription)?.trim() ||
              stringValue(skill.shortDescription)?.trim() ||
              stringValue(skill.description)?.trim() ||
              "",
            enabled: skill.enabled === true,
          },
        ];
      })
    : [];
  /** @type {ChatPluginApp[]} */
  const apps: ChatPluginApp[] = Array.isArray(detail.apps)
    ? detail.apps.flatMap((appValue) => {
        const app = chatPluginAppFromValue(appValue);
        return app ? [app] : [];
      })
    : [];
  /** @type {ChatPluginAppTemplate[]} */
  const appTemplates: ChatPluginAppTemplate[] = Array.isArray(
    detail.appTemplates,
  )
    ? detail.appTemplates.flatMap((templateValue) => {
        const template = recordValue(templateValue);
        const id = stringValue(template?.templateId)?.trim();
        const name = stringValue(template?.name)?.trim();
        if (!template || !id || !name) return [];
        return [
          {
            id,
            name,
            description: stringValue(template.description)?.trim() || "",
            category: stringValue(template.category)?.trim() || "App template",
          },
        ];
      })
    : [];
  /** @type {ChatPluginHook[]} */
  const hooks: ChatPluginHook[] = Array.isArray(detail.hooks)
    ? detail.hooks.flatMap((hookValue) => {
        const hook = recordValue(hookValue);
        const key = stringValue(hook?.key)?.trim();
        const eventName = stringValue(hook?.eventName)?.trim();
        return key && eventName ? [{ key, eventName }] : [];
      })
    : [];
  /** @type {ChatPluginScheduledTask[]} */
  const scheduledTasks: ChatPluginScheduledTask[] = Array.isArray(
    detail.scheduledTasks,
  )
    ? detail.scheduledTasks.flatMap((taskValue) => {
        const task = recordValue(taskValue);
        const key = stringValue(task?.key)?.trim();
        const name = stringValue(task?.name)?.trim();
        if (!task || !key || !name) return [];
        return [{ key, name, prompt: stringValue(task.prompt)?.trim() || "" }];
      })
    : [];

  /** @type {ChatPluginDetail} */
  const normalizedPlugin: ChatPluginDetail = {
    id: plugin.id,
    name: plugin.name,
    displayName: plugin.displayName,
    shortDescription: plugin.shortDescription,
    longDescription: plugin.longDescription,
    developerName: plugin.developerName,
    category: plugin.category,
    capabilities: plugin.capabilities,
    keywords: plugin.keywords,
    defaultPrompts: plugin.defaultPrompts,
    brandColor: plugin.brandColor,
    hasLogo: plugin.hasLogo,
    installed: plugin.installed,
    enabled: plugin.enabled,
    installPolicy: plugin.installPolicy,
    authPolicy: plugin.authPolicy,
    availability: plugin.availability,
    disabledReason: plugin.disabledReason,
    source: plugin.source,
    version: plugin.version,
    localVersion: plugin.localVersion,
    marketplaceName: plugin.marketplaceName,
    marketplaceDisplayName: plugin.marketplaceDisplayName,
    reference: plugin.reference,
    description:
      stringValue(detail.description)?.trim() || plugin.longDescription,
    shareUrl: stringValue(detail.shareUrl)?.trim() || null,
    skills,
    apps,
    appTemplates,
    mcpServers: stringList(detail.mcpServers),
    hooks,
    scheduledTasks,
  };
  return { plugin: normalizedPlugin };
}

/**
 * @param {unknown} value
 * @returns {{ appsNeedingAuth: Array<{ id: string, name: string, description: string, category: string, installUrl: string | null }>, authPolicy: string }}
 */
export function pluginInstallResultFromResponse(value: unknown): {
  appsNeedingAuth: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    installUrl: string | null;
  }>;
  authPolicy: string;
} {
  const response = recordValue(value);
  const authPolicy = stringValue(response?.authPolicy)?.trim();
  if (!response || !authPolicy || !Array.isArray(response.appsNeedingAuth)) {
    throw new Error("The Codex plugin install response format is invalid.");
  }
  return {
    appsNeedingAuth: response.appsNeedingAuth.flatMap((appValue) => {
      const app = chatPluginAppFromValue(appValue);
      return app ? [app] : [];
    }),
    authPolicy,
  };
}
