import { AlertTriangle, Blocks, Search, Sparkles } from 'lucide-react';

import { LoadingState, NeumorphicButton } from '../../shared/ui';
import { InstalledPluginTile, PluginGrid } from './PluginDirectoryCards';
import styles from './PluginsView.module.css';
import type { PluginsController } from './usePluginsController';

export function PluginCatalog({ controller }: { controller: PluginsController }) {
  const {
    browse,
    catalog,
    catalogError,
    catalogLoading,
    featured,
    installed,
    loadCatalog,
    query,
    scope,
    searchResults,
    selectPlugin,
    selectedPlugin,
    showMore,
    showSearchResults,
    visibleBrowse,
    visibleSearchResults,
  } = controller;
  const initialLoading = catalogLoading && !catalog;

  return (
    <section
      className={styles.catalog}
      data-initial-loading={initialLoading ? 'true' : undefined}
      id="plugin-directory-panel"
      role="tabpanel"
      aria-busy={catalogLoading}
      aria-label="Plugin directory"
      aria-labelledby={scope === 'discover' ? 'plugin-discover-tab' : 'plugin-installed-tab'}
    >
      {catalogError && (
        <div className={styles.errorState} role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{catalogError}</span>
          <NeumorphicButton raised onClick={() => void loadCatalog(true)}>Try again</NeumorphicButton>
        </div>
      )}

      {initialLoading && (
        <LoadingState />
      )}

      {catalog && catalog.marketplaceErrors.length > 0 && (
        <div className={styles.marketplaceWarning} role="status">
          <AlertTriangle aria-hidden="true" />
          <span>{catalog.marketplaceErrors.length} marketplace {catalog.marketplaceErrors.length === 1 ? 'source was' : 'sources were'} unavailable.</span>
        </div>
      )}

      {catalog && showSearchResults && (
        <section className={styles.catalogSection}>
          <header className={styles.sectionHeading}>
            <div><span>SEARCH</span><h2>{searchResults.length.toLocaleString()} results for “{query.trim()}”</h2></div>
          </header>
          {visibleSearchResults.length > 0 ? (
            <>
              <PluginGrid plugins={visibleSearchResults} selectedId={selectedPlugin?.id ?? null} onSelect={selectPlugin} />
              {visibleSearchResults.length < searchResults.length && (
                <NeumorphicButton size="standard" raised className={styles.showMore} onClick={showMore}>
                  Show more
                </NeumorphicButton>
              )}
            </>
          ) : (
            <div className={styles.emptyState}><Search aria-hidden="true" /><strong>No matching plugins</strong><span>Try a capability, developer, or plugin name.</span></div>
          )}
        </section>
      )}

      {catalog && !showSearchResults && scope === 'installed' && (
        <section className={styles.catalogSection}>
          <header className={styles.sectionHeading}>
            <div><span>LOCAL</span><h2>Installed plugins</h2></div>
            <p>Capabilities available to Codex on this computer.</p>
          </header>
          {installed.length > 0 ? (
            <PluginGrid plugins={installed} selectedId={selectedPlugin?.id ?? null} onSelect={selectPlugin} />
          ) : (
            <div className={styles.emptyState}><Blocks aria-hidden="true" /><strong>No plugins installed</strong><span>Choose Discover to add one from the directory.</span></div>
          )}
        </section>
      )}

      {catalog && !showSearchResults && scope === 'discover' && (
        <>
          <section className={styles.catalogSection}>
            <header className={styles.sectionHeading}>
              <div><span>READY</span><h2>Installed</h2></div>
              <p>{installed.length > 0 ? 'Available to new Codex chats.' : 'Your installed plugins will appear here.'}</p>
            </header>
            {installed.length > 0 ? (
              <div className={styles.installedStrip}>
                {installed.map((plugin) => (
                  <InstalledPluginTile
                    key={plugin.id}
                    plugin={plugin}
                    selected={selectedPlugin?.id === plugin.id}
                    onSelect={selectPlugin}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.installedEmpty}>Install a plugin below to extend Codex with skills, apps, and MCP servers.</div>
            )}
          </section>

          {featured.length > 0 && (
            <section className={styles.catalogSection}>
              <header className={styles.sectionHeading}>
                <div><span>CURATED</span><h2>Recommended</h2></div>
                <p>Featured tools from your configured marketplaces.</p>
              </header>
              <PluginGrid plugins={featured} selectedId={selectedPlugin?.id ?? null} onSelect={selectPlugin} />
            </section>
          )}

          <section className={styles.catalogSection}>
            <header className={styles.sectionHeading}>
              <div><span>EXPLORE</span><h2>Browse plugins</h2></div>
              <p>{browse.length.toLocaleString()} more extensions.</p>
            </header>
            {visibleBrowse.length > 0 ? (
              <>
                <PluginGrid plugins={visibleBrowse} selectedId={selectedPlugin?.id ?? null} onSelect={selectPlugin} />
                {visibleBrowse.length < browse.length && (
                  <NeumorphicButton size="standard" raised className={styles.showMore} onClick={showMore}>
                    Show more
                  </NeumorphicButton>
                )}
              </>
            ) : (
              <div className={styles.emptyState}><Sparkles aria-hidden="true" /><strong>Everything is already in view</strong></div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
