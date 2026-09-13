import type { CodexPluginCatalog } from '../../cheshiDesktop';

export function createPluginCatalogCache(readCatalog: (forceRefetch: boolean) => Promise<CodexPluginCatalog>) {
  let catalog: CodexPluginCatalog | null = null;
  let pending: { promise: Promise<CodexPluginCatalog>; forced: boolean } | null = null;

  return {
    peek: () => catalog,
    load(forceRefetch = false): Promise<CodexPluginCatalog> {
      if (pending && (!forceRefetch || pending.forced)) return pending.promise;
      if (!forceRefetch && catalog) return Promise.resolve(catalog);

      const request = {
        forced: forceRefetch,
        promise: Promise.resolve().then(() => readCatalog(forceRefetch)).then((nextCatalog) => {
          if (pending === request) catalog = nextCatalog;
          return nextCatalog;
        }).finally(() => {
          if (pending === request) pending = null;
        }),
      };
      pending = request;
      return request.promise;
    },
  };
}
