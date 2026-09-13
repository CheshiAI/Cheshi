import { Blocks, PanelRight, RefreshCw, ToyBrick } from 'lucide-react';
import { useState } from 'react';

import {
  LiquidGlassPanel,
  NeumorphicButton,
  NeumorphicTextField,
  SearchClearButton,
  TieredHeader,
  draggableWindowRegionStyle,
  nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { PluginCatalog } from './PluginCatalog';
import { PluginAddDialog } from './PluginAddDialog';
import { PluginDetails } from './PluginDetails';
import styles from './PluginsView.module.css';
import { usePluginsController } from './usePluginsController';

const SEARCH_PLACEHOLDER = 'Search plugins, capabilities, and developers';

interface PluginsViewProps {
  chatContextId?: string;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  onOpenChat: (threadId: string) => void;
}

export function PluginsView({ chatContextId, rightSidebarOpen, onToggleRightSidebar, onOpenChat }: PluginsViewProps) {
  const controller = usePluginsController();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const {
    catalogLoading,
    loadCatalog,
    query,
    scope,
    searchInputRef,
    selectedPlugin,
    setQuery,
    setScope,
  } = controller;

  return (
    <main className={styles.root} data-detail-open={selectedPlugin ? 'true' : undefined}>
      <TieredHeader
        className={styles.header}
        primary={(
          <>
            <div className={styles.title}>
              <NeumorphicButton raised aria-hidden="true" className={`theme-toggle ${styles.titleMark}`} disabled>
                <Blocks aria-hidden="true" />
              </NeumorphicButton>
              <h1>Plugins</h1>
            </div>
            <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
              <NeumorphicTextField
                className={styles.search}
                fitPlaceholder
                ref={searchInputRef}
                value={query}
                type="search"
                placeholder={SEARCH_PLACEHOLDER}
                aria-label="Search plugins"
                onChange={(event) => setQuery(event.target.value)}
                trailingAction={query ? (
                  <SearchClearButton
                    aria-label="Clear plugin search"
                    onClick={() => {
                      setQuery('');
                      requestAnimationFrame(() => searchInputRef.current?.focus());
                    }}
                  />
                ) : undefined}
              />
              <div className={styles.scopeSwitch} role="tablist" aria-label="Plugin directory scope">
                <NeumorphicButton
                  raised={scope === 'discover'}
                  className={styles.scopeOption}
                  id="plugin-discover-tab"
                  role="tab"
                  aria-controls="plugin-directory-panel"
                  aria-selected={scope === 'discover'}
                  onClick={() => setScope('discover')}
                >
                  Discover
                </NeumorphicButton>
                <NeumorphicButton
                  raised={scope === 'installed'}
                  className={styles.scopeOption}
                  id="plugin-installed-tab"
                  role="tab"
                  aria-controls="plugin-directory-panel"
                  aria-selected={scope === 'installed'}
                  onClick={() => setScope('installed')}
                >
                  Installed
                </NeumorphicButton>
              </div>
              <NeumorphicButton
                raised
                className={`codegraph-inspector-toggle ${styles.headerAction}`}
                aria-label="Refresh plugin directory"
                disabled={catalogLoading}
                onClick={() => void loadCatalog(true)}
              >
                <RefreshCw className={catalogLoading ? styles.spinning : undefined} aria-hidden="true" />
              </NeumorphicButton>
              <NeumorphicButton
                raised
                className={`codegraph-inspector-toggle ${styles.headerAction}`}
                aria-label="Add plugins"
                aria-haspopup="dialog"
                title="Add plugins"
                onClick={() => setAddDialogOpen(true)}
              >
                <ToyBrick aria-hidden="true" />
              </NeumorphicButton>
              <NeumorphicButton
                raised
                className={`codegraph-inspector-toggle ${styles.headerAction}`}
                aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
                aria-pressed={rightSidebarOpen}
                onClick={onToggleRightSidebar}
              >
                <PanelRight aria-hidden="true" />
              </NeumorphicButton>
            </div>
          </>
        )}
        style={draggableWindowRegionStyle}
      />

      <div className={styles.body}>
        <PluginCatalog controller={controller} />
        <div className={styles.detailsColumn} aria-hidden={!selectedPlugin} inert={!selectedPlugin}>
          <LiquidGlassPanel className={styles.detailsPanel}>
            <PluginDetails controller={controller} />
          </LiquidGlassPanel>
        </div>
      </div>
      {addDialogOpen && <PluginAddDialog chatContextId={chatContextId} onClose={() => setAddDialogOpen(false)} onOpenChat={onOpenChat} onMarketplaceAdded={async () => {
        if (!await loadCatalog(true)) throw new Error('The marketplace was registered, but the catalog could not refresh. Try again.');
      }} />}
    </main>
  );
}
