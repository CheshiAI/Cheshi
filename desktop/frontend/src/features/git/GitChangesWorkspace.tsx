import { GitPullRequestClosed, ListChecks } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  LiquidGlassPanel,
  LoadingState,
  NeumorphicButton,
  NeumorphicCheckbox,
  NeumorphicTextField,
  SidebarPanelHeader,
} from '../../shared/ui';
import type { GitDiffRequest, GitDiscardTarget, GitFileChange } from '../../cheshiDesktop';
import { GitDiscardDialog } from './GitDiscardDialog';
import { checkedGitDiscardTargets, reconcileGitChangeSelection, selectGitChanges } from './gitChangeSelection';
import { GitDiffViewer } from './GitDiffViewer';
import { changeStatus } from './gitWorkspaceModel';
import { OverlayScrollArea } from '../../shared/ui/OverlayScrollArea';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import workspaceStyles from './GitWorkspace.module.css';
import styles from './GitChangesSidebar.module.css';
import type { GitWorkspaceController } from './useGitWorkspaceController';

type ChangeScope = Extract<GitDiffRequest['scope'], 'working' | 'staged'>;

interface GitChangeGroupProps {
  busy: boolean;
  changes: GitFileChange[];
  scope: ChangeScope;
  selectedTargets: GitDiscardTarget[];
  onSelect: (change: GitFileChange, scope: ChangeScope, event: MouseEvent<HTMLButtonElement>) => void;
  onDiscard: (target: GitDiscardTarget) => void;
  onToggle: (change: GitFileChange) => void;
  onToggleAll: (changes: GitFileChange[]) => void;
}

function GitChangeGroup({
  busy,
  changes,
  scope,
  selectedTargets,
  onSelect,
  onDiscard,
  onToggle,
  onToggleAll,
}: GitChangeGroupProps) {
  const staged = scope === 'staged';
  const label = staged ? 'STAGED' : 'UNSTAGED';
  const emptyLabel = staged ? 'No staged changes' : 'No unstaged changes';
  const toggleLabel = staged ? 'Unstage' : 'Stage';
  const selectedPaths = new Set(selectedTargets.filter((target) => target.scope === scope).map((target) => target.path));

  return (
    <section className={styles.changeGroup}>
      <div className={styles.groupHeader}>
        <span className={styles.groupLabel}>{label}</span>
        {changes.length > 0 && (
          <TooltipButton
            variant="ghost" size="icon"
            aria-label={`${toggleLabel} all changes`}
            disabled={busy}
            title={`${toggleLabel} all`}
            onClick={() => onToggleAll(changes)}
          >
            <ListChecks aria-hidden="true" />
          </TooltipButton>
        )}
      </div>
      {changes.length === 0 && <span className={styles.groupEmpty}>{emptyLabel}</span>}
      {changes.map((change) => (
        <div
          className={styles.changeRow}
          data-selected={selectedPaths.has(change.path) ? 'true' : undefined}
          key={`${scope}:${change.path}`}
        >
          <NeumorphicCheckbox
            aria-label={`${toggleLabel} ${change.path}`}
            className={styles.changeCheckbox}
            checked={staged}
            disabled={busy}
            title={toggleLabel}
            onChange={() => onToggle(change)}
          />
          <button
            className={styles.changeTrigger}
            type="button"
            aria-pressed={selectedPaths.has(change.path)}
            title="Use ⌘/Ctrl-click or Shift-click to select multiple files."
            onClick={(event) => onSelect(change, scope, event)}
          >
            <span className={styles.status} data-status={changeStatus(change)}>{changeStatus(change)}</span>
            <span className={styles.changeName}>{change.path}</span>
          </button>
          <TooltipButton
            variant="ghost" size="icon"
            aria-label={`Discard changes in ${change.path}`}
            title="Discard changes"
            disabled={busy}
            onClick={() => onDiscard({ path: change.path, scope })}
          >
            <GitPullRequestClosed aria-hidden="true" />
          </TooltipButton>
        </div>
      ))}
    </section>
  );
}

export function GitChangesWorkspace({ controller, onOpenWorkspaceFile, sidebarTarget, active = true, onOpenChanges, projectSelector }: {
  projectSelector?: ReactNode;
  sidebarTarget?: HTMLElement | null;
  active?: boolean;
  onOpenChanges?: () => void;
  controller: GitWorkspaceController;
  onOpenWorkspaceFile: (path: string) => void;
}) {
  const {
    busy,
    changes,
    commit,
    commitMessage,
    diff,
    diffFiles,
    diffLoading,
    discardChanges,
    error,
    loading,
    selectChange,
    selection,
    selectedDiffPath,
    setCommitMessage,
    setSelectedDiffPath,
    stagedChanges,
    snapshot,
    stagePaths,
    unstagedChanges,
    unstagePaths,
  } = controller;
  const commitUnavailable = busy || !snapshot.available || stagedChanges.length === 0;
  const [selectedChanges, setSelectedChanges] = useState<GitDiscardTarget[] | null>(null);
  const [discardTargets, setDiscardTargets] = useState<GitDiscardTarget[] | null>(null);
  const selectionAnchor = useRef<GitDiscardTarget | null>(null);
  const targets = useMemo<GitDiscardTarget[]>(() => [
    ...changes.filter(change => change.unstaged === true).map(change => ({ path: change.path, scope: 'working' as const })),
    ...changes.filter(change => change.staged === true).map(change => ({ path: change.path, scope: 'staged' as const })),
  ], [changes]);
  const defaultSelection: GitDiscardTarget[] = selection && selection.scope !== 'commit'
    ? [{ path: selection.path, scope: selection.scope }]
    : [];
  const selectedTargets = reconcileGitChangeSelection(selectedChanges ?? defaultSelection, targets);
  useLayoutEffect(() => {
    setSelectedChanges(current => current === null ? null : reconcileGitChangeSelection(current, targets));
    if (selectionAnchor.current) {
      selectionAnchor.current = reconcileGitChangeSelection([selectionAnchor.current], targets)[0] ?? null;
    }
  }, [targets]);
  const checkedTargets = checkedGitDiscardTargets(changes);
  const selectRow = (change: GitFileChange, scope: ChangeScope, event: MouseEvent<HTMLButtonElement>): void => {
    const target = { path: change.path, scope };
    setSelectedChanges(selectGitChanges({
      targets, selected: selectedTargets, target, anchor: selectionAnchor.current ?? selectedTargets[0] ?? null,
      toggle: event.metaKey || event.ctrlKey, range: event.shiftKey,
    }));
    if (!event.shiftKey) selectionAnchor.current = target;
    onOpenChanges?.();
    selectChange(change, scope);
  };

  const sidebar = (
    <LiquidGlassPanel as="section" className={styles.sidebar} aria-label="Git changes">
      <SidebarPanelHeader title="GITHUB" count={snapshot.available ? changes.length : undefined} icon={<span className={workspaceStyles.githubMark} aria-hidden="true" />}
        actions={<TooltipButton variant="ghost" size="icon"
          aria-label={`Discard changes in ${checkedTargets.length} checked files`} title="Discard checked changes"
          disabled={busy || !snapshot.available || checkedTargets.length === 0} onClick={() => setDiscardTargets(checkedTargets)}>
          <GitPullRequestClosed aria-hidden="true" />
        </TooltipButton>} />
      <OverlayScrollArea className={styles.changeList} label="Changed files">
        {!snapshot.available ? loading ? <LoadingState label="Loading changes…" /> : <p className={styles.groupEmpty} role="alert">
          {error || snapshot.message || 'Git repository unavailable'}
        </p> : <>
          <GitChangeGroup
            busy={busy}
            changes={unstagedChanges}
            scope="working"
            selectedTargets={selectedTargets}
            onSelect={selectRow}
            onDiscard={(target) => setDiscardTargets([target])}
            onToggle={(change) => void stagePaths([change.path], `${change.path} staged.`)}
            onToggleAll={(groupChanges) => void stagePaths(
              groupChanges.map((change) => change.path),
              'Changes staged.',
            )}
          />
          <GitChangeGroup
            busy={busy}
            changes={stagedChanges}
            scope="staged"
            selectedTargets={selectedTargets}
            onSelect={selectRow}
            onDiscard={(target) => setDiscardTargets([target])}
            onToggle={(change) => void unstagePaths([change.path], `${change.path} unstaged.`)}
            onToggleAll={(groupChanges) => void unstagePaths(
              groupChanges.map((change) => change.path),
              'Changes unstaged.',
            )}
          />
        </>}
      </OverlayScrollArea>
      <footer className={styles.commitBar}>
        <NeumorphicTextField
          variant="standard"
          aria-label="Commit message"
          disabled={commitUnavailable}
          placeholder="Commit message"
          value={commitMessage}
          onClear={() => setCommitMessage('')}
          clearLabel="Clear commit message"
          onChange={(event) => setCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            if (!commitUnavailable && commitMessage.trim() && (event.metaKey || event.ctrlKey) && event.key === 'Enter') void commit();
          }}
        />
        <NeumorphicButton
          variant="standard"
          disabled={commitUnavailable || !commitMessage.trim()}
          onClick={() => void commit()}
        >
          Commit
        </NeumorphicButton>
      </footer>
      {projectSelector && <div className={styles.projectSelector}>{projectSelector}</div>}
    </LiquidGlassPanel>
  );
  return <>
    {sidebarTarget && createPortal(sidebar, sidebarTarget)}
    <div className={sidebarTarget === undefined ? workspaceStyles.splitLayout : styles.diffWorkspace} hidden={!active}>
      {sidebarTarget === undefined && sidebar}
      <GitDiffViewer
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        diff={diff}
        files={diffFiles}
        loading={diffLoading}
        selectedPath={selectedDiffPath}
        onSelectPath={setSelectedDiffPath}
      />
    </div>
    {discardTargets && (
      <GitDiscardDialog
        targets={discardTargets}
        onClose={() => setDiscardTargets(null)}
        onDiscard={async (request) => {
          await discardChanges(request);
          setSelectedChanges(null);
        }}
      />
    )}
  </>;
}
