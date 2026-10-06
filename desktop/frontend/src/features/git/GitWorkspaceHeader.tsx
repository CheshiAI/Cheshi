import {
  AlertTriangle,
  Check,
  PanelRight,
  RefreshCw,
} from 'lucide-react';

import {
  SidebarToggle,
  FilterTabList,
  NeumorphicButton,
  TieredHeader,
  draggableWindowRegionStyle,
  nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
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
          <FilterTabList as="nav" className={styles.tabs} aria-label="Git sections">
            {gitWorkspaceTabs.map((item) => (
              <NeumorphicButton
                variant="ghost"
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
              </NeumorphicButton>
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
            <TooltipButton
              variant="ghost"
              size="icon"
              aria-busy={refreshing}
              aria-label={refreshing ? 'Refreshing Git' : 'Refresh Git'}
              disabled={busy || refreshing}
              title={refreshing ? 'Refreshing…' : 'Refresh'}
              onClick={() => onRefreshIssues ? onRefreshIssues() : void refreshRepository()}
            >
              <RefreshCw className={refreshing ? styles.spinner : undefined} aria-hidden="true" />
            </TooltipButton>
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
