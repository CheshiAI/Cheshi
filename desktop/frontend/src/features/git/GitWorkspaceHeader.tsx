import {
  AlertTriangle,
  Check,
  PanelRight,
  RefreshCw,
} from 'lucide-react';

import {
  SidebarToggle,
  FilterTab,
  FilterTabList,
  NeumorphicButton,
  TieredHeader,
  draggableWindowRegionStyle,
  nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { gitWorkspaceTabs } from './gitWorkspaceModel';
import styles from './GitWorkspace.module.css';
import type { GitWorkspaceController } from './useGitWorkspaceController';

interface GitWorkspaceHeaderProps {
  controller: GitWorkspaceController;
  onRefreshIssues?: () => void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export function GitWorkspaceHeader({ controller, rightSidebarOpen, onToggleRightSidebar, onRefreshIssues }: GitWorkspaceHeaderProps) {
  const {
    busy,
    changes,
    error,
    notice,
    refreshRepository,
    refreshing,
    selectTab,
    tab,
  } = controller;

  return (
    <TieredHeader
      className={styles.header}
      style={draggableWindowRegionStyle}
      primary={(
        <>
          <div className={styles.title}>
            <NeumorphicButton
              raised
              aria-hidden="true"
              className={`theme-toggle ${styles.titleMark}`}
              disabled
            >
              <span className={styles.githubMark} />
            </NeumorphicButton>
            <h1>Github</h1>
          </div>
          <FilterTabList as="nav" className={styles.tabs} aria-label="Git sections">
            {gitWorkspaceTabs.map((item) => (
              <FilterTab
                active={tab === item.id}
                aria-current={tab === item.id ? 'page' : undefined}
                key={item.id}
                style={nonDraggableWindowRegionStyle}
                onClick={() => selectTab(item.id)}
              >
                {item.label}
                {item.id === 'changes' && changes.length > 0 && (
                  <span className={styles.changeCountBadge}>{changes.length}</span>
                )}
              </FilterTab>
            ))}
          </FilterTabList>
          <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
            {(error || notice) && (
              <span
                className={styles.headerStatus}
                data-kind={error ? 'error' : 'notice'}
                role={error ? 'alert' : 'status'}
                title={error ?? notice ?? undefined}
              >
                {error ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
                <span>{error ?? notice}</span>
              </span>
            )}
            <NeumorphicButton
              raised
              aria-busy={refreshing}
              aria-label={refreshing ? 'Refreshing Git' : 'Refresh Git'}
              className="sidebar-heading-action"
              disabled={busy || refreshing}
              title={refreshing ? 'Refreshing…' : 'Refresh'}
              onClick={() => onRefreshIssues ? onRefreshIssues() : void refreshRepository()}
            >
              <RefreshCw className={refreshing ? styles.spinner : undefined} aria-hidden="true" />
            </NeumorphicButton>
            <SidebarToggle
              raised
              className="sidebar-heading-action"
              aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
              aria-expanded={rightSidebarOpen}
              onClick={onToggleRightSidebar}
            >
              <PanelRight aria-hidden="true" />
            </SidebarToggle>
          </div>
        </>
      )}
    />
  );
}
