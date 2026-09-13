import type { CodexPluginDetail, CodexPluginSummary } from '../../cheshiDesktop';

interface DetailCacheEntry {
  detail: CodexPluginDetail | null;
  pending: Promise<CodexPluginDetail> | null;
}

function pluginDetailKey(plugin: CodexPluginSummary): string {
  return JSON.stringify([
    plugin.id, plugin.reference, plugin.version, plugin.localVersion, plugin.installed, plugin.enabled,
  ]);
}

export function createPluginDetailCache(readDetail: (plugin: CodexPluginSummary) => Promise<CodexPluginDetail>) {
  const entries = new Map<string, DetailCacheEntry>();
  return {
    peek: (plugin: CodexPluginSummary) => entries.get(pluginDetailKey(plugin))?.detail ?? null,
    clear: () => entries.clear(),
    load(plugin: CodexPluginSummary): Promise<CodexPluginDetail> {
      const key = pluginDetailKey(plugin);
      let entry = entries.get(key);
      if (!entry) {
        entry = { detail: null, pending: null };
        entries.set(key, entry);
      }
      if (entry.detail) return Promise.resolve(entry.detail);
      if (entry.pending) return entry.pending;
      const current = entry;
      current.pending = Promise.resolve().then(() => readDetail(plugin)).then((detail) => {
        current.detail = detail;
        return detail;
      }).finally(() => { current.pending = null; });
      return current.pending;
    },
  };
}
