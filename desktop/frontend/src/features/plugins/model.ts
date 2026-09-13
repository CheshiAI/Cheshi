import type { CodexPluginCatalog, CodexPluginSummary } from '../../cheshiDesktop';

const PLUGIN_COLORS = ['#51858a', '#7d68a6', '#9a7048', '#4f8268', '#a45f69', '#5976a6'];

function normalizedSearchText(plugin: CodexPluginSummary): string {
  return [
    plugin.displayName,
    plugin.name,
    plugin.shortDescription,
    plugin.longDescription,
    plugin.developerName,
    plugin.category,
    plugin.marketplaceDisplayName,
    ...plugin.capabilities,
    ...plugin.keywords,
  ].join('\n').toLocaleLowerCase();
}

export function pluginInitial(plugin: CodexPluginSummary): string {
  return (plugin.displayName.trim() || plugin.name.trim()).slice(0, 1).toLocaleUpperCase() || 'P';
}

export function pluginBrandColor(plugin: CodexPluginSummary): string {
  if (plugin.brandColor && /^#[\da-f]{6}$/i.test(plugin.brandColor)) return plugin.brandColor;
  let hash = 0;
  for (const character of plugin.id) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return PLUGIN_COLORS[Math.abs(hash) % PLUGIN_COLORS.length] ?? '#51858a';
}

export function filterPlugins(plugins: readonly CodexPluginSummary[], query: string): CodexPluginSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...plugins];
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return plugins.filter((plugin) => {
    const searchText = normalizedSearchText(plugin);
    return terms.every((term) => searchText.includes(term));
  });
}

export function featuredPlugins(catalog: CodexPluginCatalog): CodexPluginSummary[] {
  const pluginsById = new Map(catalog.plugins.map((plugin) => [plugin.id, plugin]));
  return catalog.featuredPluginIds.flatMap((id) => {
    const plugin = pluginsById.get(id);
    return plugin ? [plugin] : [];
  });
}

export function installedPlugins(plugins: readonly CodexPluginSummary[]): CodexPluginSummary[] {
  return plugins
    .filter((plugin) => plugin.installed)
    .sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' }));
}

export function canInstallPlugin(plugin: CodexPluginSummary): boolean {
  return !plugin.installed
    && plugin.installPolicy === 'AVAILABLE'
    && plugin.availability === 'AVAILABLE';
}

export function canUninstallPlugin(plugin: CodexPluginSummary): boolean {
  return plugin.installed && plugin.installPolicy !== 'INSTALLED_BY_DEFAULT';
}

export function pluginUninstallId(plugin: CodexPluginSummary): string {
  return plugin.reference.remoteMarketplaceName ? plugin.reference.pluginName : plugin.id;
}
