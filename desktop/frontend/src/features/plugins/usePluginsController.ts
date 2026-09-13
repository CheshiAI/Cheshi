import { invalidateSkillCatalog } from '../../shared/skillCatalogChanges';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import { createPluginCatalogCache } from './pluginCatalogCache';
import { createPluginDetailCache } from './pluginDetailCache';
import {
  cheshiDesktop as desktopApi,
  type CodexPluginApp,
  type CodexPluginCatalog,
  type CodexPluginDetail,
  type CodexPluginSummary,
} from '../../cheshiDesktop';
import {
  featuredPlugins,
  filterPlugins,
  installedPlugins,
  pluginUninstallId,
} from './model';

const PAGE_SIZE = 24;
const catalogCache = createPluginCatalogCache(async (forceRefetch) => {
  if (!desktopApi) throw new Error('The plugin directory is available in Cheshi Desktop.');
  return desktopApi.listCodexPlugins(forceRefetch);
});
const detailCache = createPluginDetailCache(async (plugin) => {
  if (!desktopApi) throw new Error('Plugin details are available in Cheshi Desktop.');
  return (await desktopApi.readCodexPlugin(plugin.reference)).plugin;
});

export type CatalogScope = 'discover' | 'installed';
export type ConfirmationAction = 'install' | 'uninstall' | null;

export function usePluginsController() {
  const [catalog, setCatalog] = useState<CodexPluginCatalog | null>(() => catalogCache.peek());
  const [catalogLoading, setCatalogLoading] = useState(() => !catalogCache.peek());
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<CatalogScope>('discover');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedPlugin, setSelectedPlugin] = useState<CodexPluginSummary | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detail, setDetail] = useState<CodexPluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mutatingPluginId, setMutatingPluginId] = useState<string | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [appsNeedingAuth, setAppsNeedingAuth] = useState<CodexPluginApp[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailRequestId = useRef(0);
  const catalogRequestId = useRef(0);

  const loadCatalog = useCallback(async (
    forceRefetch = false,
    quiet = false,
  ): Promise<CodexPluginCatalog | null> => {
    if (!desktopApi) {
      setCatalogError('The plugin directory is available in Cheshi Desktop.');
      setCatalogLoading(false);
      return null;
    }
    const requestId = ++catalogRequestId.current;
    if (forceRefetch) detailCache.clear();
    if (!quiet) setCatalogLoading(forceRefetch || !catalogCache.peek());
    setCatalogError(null);
    try {
      const nextCatalog = await catalogCache.load(forceRefetch);
      if (catalogRequestId.current === requestId) setCatalog(nextCatalog);
      return nextCatalog;
    } catch (error) {
      if (catalogRequestId.current === requestId) {
        setCatalogError(errorMessage(error, 'The plugin directory request failed.'));
      }
      return null;
    } finally {
      if (catalogRequestId.current === requestId) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, scope]);

  const openPlugin = useCallback(async (plugin: CodexPluginSummary) => {
    const requestId = detailRequestId.current + 1;
    detailRequestId.current = requestId;
    setSelectedPlugin(plugin);
    setDetailsOpen(true);
    const cachedDetail = detailCache.peek(plugin);
    setDetail(cachedDetail);
    setDetailError(null);
    setDetailLoading(!cachedDetail);
    setConfirmationAction(null);
    setAppsNeedingAuth([]);
    if (cachedDetail) return;
    if (!desktopApi) {
      setDetailError('Plugin details are available in Cheshi Desktop.');
      setDetailLoading(false);
      return;
    }
    try {
      const nextDetail = await detailCache.load(plugin);
      if (detailRequestId.current === requestId) setDetail(nextDetail);
    } catch (error) {
      if (detailRequestId.current === requestId) {
        setDetailError(errorMessage(error, 'The plugin directory request failed.'));
      }
    } finally {
      if (detailRequestId.current === requestId) setDetailLoading(false);
    }
  }, []);

  const selectPlugin = useCallback((plugin: CodexPluginSummary): void => {
    setActionNotice(null);
    void openPlugin(plugin);
  }, [openPlugin]);

  const closeDetails = useCallback((): void => {
    detailRequestId.current += 1;
    setDetailsOpen(false);
    setDetailLoading(false);
  }, []);

  const mutatePlugin = useCallback(async (
    action: Exclude<ConfirmationAction, null>,
  ): Promise<void> => {
    if (!desktopApi || !selectedPlugin) return;
    const plugin = detail ?? selectedPlugin;
    setMutatingPluginId(plugin.id);
    setActionNotice(null);
    try {
      let runtimeRefreshed: boolean;
      let authApps: CodexPluginApp[] = [];
      if (action === 'install') {
        const result = await desktopApi.installCodexPlugin(plugin.reference);
        runtimeRefreshed = result.runtimeRefreshed;
        authApps = result.appsNeedingAuth;
      } else {
        const result = await desktopApi.uninstallCodexPlugin(pluginUninstallId(plugin));
        runtimeRefreshed = result.runtimeRefreshed;
      }
      invalidateSkillCatalog();
      const nextCatalog = await loadCatalog(true, true);
      const nextPlugin = nextCatalog?.plugins.find(({ id }) => id === plugin.id);
      if (nextPlugin) await openPlugin(nextPlugin);
      const runtimeNote = runtimeRefreshed
        ? 'It is ready for new chats.'
        : 'Start a new chat to load its runtime capabilities.';
      setActionNotice(`${plugin.displayName} was ${action === 'install' ? 'installed' : 'removed'}. ${runtimeNote}`);
      setAppsNeedingAuth(authApps);
    } catch (error) {
      setActionNotice(errorMessage(error, 'The plugin directory request failed.'));
    } finally {
      setMutatingPluginId(null);
      setConfirmationAction(null);
    }
  }, [detail, loadCatalog, openPlugin, selectedPlugin]);

  const installed = useMemo(() => installedPlugins(catalog?.plugins ?? []), [catalog]);
  const featured = useMemo(() => catalog ? featuredPlugins(catalog) : [], [catalog]);
  const featuredIds = useMemo(() => new Set(featured.map(({ id }) => id)), [featured]);
  const browse = useMemo(
    () => (catalog?.plugins ?? []).filter((plugin) => !plugin.installed && !featuredIds.has(plugin.id)),
    [catalog, featuredIds],
  );
  const searchResults = useMemo(
    () => filterPlugins(scope === 'installed' ? installed : catalog?.plugins ?? [], query),
    [catalog, installed, query, scope],
  );
  const selected = detail ?? selectedPlugin;
  const showMore = (): void => setVisibleCount((count) => count + PAGE_SIZE);

  return {
    actionNotice,
    appsNeedingAuth,
    browse,
    catalog,
    catalogError,
    catalogLoading,
    closeDetails,
    confirmationAction,
    detail,
    detailError,
    detailLoading,
    featured,
    installed,
    loadCatalog,
    mutatePlugin,
    mutating: selected ? mutatingPluginId === selected.id : false,
    query,
    scope,
    searchInputRef,
    searchResults,
    selectPlugin,
    selected,
    selectedPlugin: detailsOpen ? selectedPlugin : null,
    setConfirmationAction,
    setQuery,
    setScope,
    showMore,
    showSearchResults: query.trim().length > 0,
    visibleBrowse: browse.slice(0, visibleCount),
    visibleSearchResults: searchResults.slice(0, visibleCount),
  };
}

export type PluginsController = ReturnType<typeof usePluginsController>;
