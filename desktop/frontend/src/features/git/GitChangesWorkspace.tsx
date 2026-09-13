import { FileText, GitPullRequestClosed, ListChecks } from 'lucide-react';
import { useRef, useState, type MouseEvent } from 'react';

import {
  LiquidGlassPanel,
  NeumorphicButton,
  NeumorphicCheckbox,
  NeumorphicTextField,
  SearchClearButton,
} from '../../shared/ui';
import type { GitDiffRequest, GitDiscardTarget, GitFileChange } from '../../cheshiDesktop';
import { GitDiscardDialog } from './GitDiscardDialog';
import { checkedGitDiscardTargets, gitChangeKey, selectGitChanges } from './gitChangeSelection';
import { GitDiffViewer } from './GitDiffViewer';
import { changeStatus } from './gitWorkspaceModel';
import { MarkedPanelTitle } from './GitPullRequestPanels';
import styles from './GitWorkspace.module.css';
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
          <NeumorphicButton
            raised
            aria-label={`${toggleLabel} all changes`}
            className={`theme-toggle ${styles.smallAction}`}
            disabled={busy}
            title={`${toggleLabel} all`}
            onClick={() => onToggleAll(changes)}
          >
            <ListChecks aria-hidden="true" />
          </NeumorphicButton>
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
          <NeumorphicButton
            raised
            className={`sidebar-heading-action ${styles.discardAction}`}
            aria-label={`Discard changes in ${change.path}`}
            title="Discard changes"
            disabled={busy}
            onClick={() => onDiscard({ path: change.path, scope })}
          >
            <GitPullRequestClosed aria-hidden="true" />
          </NeumorphicButton>
        </div>
      ))}
    </section>
  );
}

export function GitChangesWorkspace({ controller, onOpenWorkspaceFile }: {
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
    selectChange,
    selection,
    selectedDiffPath,
    setCommitMessage,
    setSelectedDiffPath,
    stagedChanges,
    stagePaths,
    unstagedChanges,
    unstagePaths,
  } = controller;
  const commitUnavailable = busy || stagedChanges.length === 0;
  const commitInputRef = useRef<HTMLInputElement>(null);
  const [selectedChanges, setSelectedChanges] = useState<GitDiscardTarget[] | null>(null);
  const [discardTargets, setDiscardTargets] = useState<GitDiscardTarget[] | null>(null);
  const selectionAnchor = useRef<GitDiscardTarget | null>(null);
  const targets: GitDiscardTarget[] = [
    ...unstagedChanges.map((change) => ({ path: change.path, scope: 'working' as const })),
    ...stagedChanges.map((change) => ({ path: change.path, scope: 'staged' as const })),
  ];
  const defaultSelection: GitDiscardTarget[] = selection && selection.scope !== 'commit'
    ? [{ path: selection.path, scope: selection.scope }]
    : [];
  const availableKeys = new Set(targets.map(gitChangeKey));
  const selectedTargets = (selectedChanges ?? defaultSelection).filter((target) => availableKeys.has(gitChangeKey(target)));
  const checkedTargets = checkedGitDiscardTargets(changes);
  const selectRow = (change: GitFileChange, scope: ChangeScope, event: MouseEvent<HTMLButtonElement>): void => {
    const target = { path: change.path, scope };
    setSelectedChanges(selectGitChanges({
      targets, selected: selectedTargets, target, anchor: selectionAnchor.current ?? selectedTargets[0] ?? null,
      toggle: event.metaKey || event.ctrlKey, range: event.shiftKey,
    }));
    if (!event.shiftKey) selectionAnchor.current = target;
    selectChange(change, scope);
  };

  return (
    <>
      <div className={styles.splitLayout}>
        <LiquidGlassPanel as="section" className={styles.listPanel} data-liquid-glass-surface="side-panel">
          <header className={styles.panelHeader}>
            <div className={styles.changeTitle}>
              <MarkedPanelTitle icon={FileText} title="Local changes" />
              {changes.length > 0 && (
                <span className={styles.changeCountBadge}>{changes.length}</span>
              )}
            </div>
            {changes.length > 0 && (
              <NeumorphicButton
                raised
                className={`sidebar-heading-action ${styles.discardCheckedAction}`}
                aria-label={`Discard changes in ${checkedTargets.length} checked files`}
                title="Discard checked changes"
                disabled={busy || checkedTargets.length === 0}
                onClick={() => setDiscardTargets(checkedTargets)}
              >
                <GitPullRequestClosed aria-hidden="true" />
              </NeumorphicButton>
            )}
          </header>
          <div className={styles.changeList}>
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
          </div>
          <footer className={styles.commitBar}>
            <NeumorphicTextField
              ref={commitInputRef}
              aria-label="Commit message"
              disabled={commitUnavailable}
              placeholder="Commit message"
              value={commitMessage}
              trailingAction={commitMessage ? (
                <SearchClearButton
                  aria-label="Clear commit message"
                  disabled={commitUnavailable}
                  onClick={() => {
                    setCommitMessage('');
                    commitInputRef.current?.focus();
                  }}
                />
              ) : undefined}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if (!commitUnavailable && commitMessage.trim() && (event.metaKey || event.ctrlKey) && event.key === 'Enter') void commit();
              }}
            />
            <NeumorphicButton
              size="standard"
              raised
              className="neumorphic-surface"
              disabled={commitUnavailable || !commitMessage.trim()}
              onClick={() => void commit()}
            >
              Commit
            </NeumorphicButton>
          </footer>
        </LiquidGlassPanel>
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
    </>
  );
}
