import { Blocks, PanelRight, RefreshCw, ToyBrick } from 'lucide-react';
import { useState } from 'react';

import {
  SidebarToggle,
  LiquidGlassPanel,
  NeumorphicButton,
  NeumorphicTextField,
  TieredHeader,
  draggableWindowRegionStyle,
  nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { TooltipButton } from '../../shared/ui/TooltipButton';
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
            <SidebarPanelTitle icon={<Blocks aria-hidden="true" />} title="PLUGINS" />
            <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
              <NeumorphicTextField
                variant="standard"
                className={styles.search}
                ref={searchInputRef}
                value={query}
                type="search"
                placeholder={SEARCH_PLACEHOLDER}
                aria-label="Search plugins"
                onChange={(event) => setQuery(event.target.value)}
                onClear={() => setQuery('')}
                clearLabel="Clear plugin search"
              />
              <div className={styles.scopeSwitch} role="tablist" aria-label="Plugin directory scope">
                <NeumorphicButton
                  variant="ghost"
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
                  variant="ghost"
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
              <TooltipButton
                variant="ghost"
                size="icon"
                title="Refresh plugin directory"
                aria-label="Refresh plugin directory"
                disabled={catalogLoading}
                onClick={() => void loadCatalog(true)}
              >
                <RefreshCw className={catalogLoading ? styles.spinning : undefined} aria-hidden="true" />
              </TooltipButton>
              <TooltipButton
                variant="ghost"
                size="icon"
                aria-label="Add plugins"
                aria-haspopup="dialog"
                title="Add plugins"
                onClick={() => setAddDialogOpen(true)}
              >
                <ToyBrick aria-hidden="true" />
              </TooltipButton>
              <SidebarToggle
                variant="ghost"
                size="icon"
                aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
                title={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
                aria-expanded={rightSidebarOpen}
                onClick={onToggleRightSidebar}
              >
                <PanelRight aria-hidden="true" />
              </SidebarToggle>
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
