import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  FolderGit2,
  GitBranch,
  X,
} from 'lucide-react';
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SubmitEvent,
} from 'react';

import { NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import type { GitBranchSummary } from '../../cheshiDesktop';
import { GitBranchContextMenu, type GitBranchContextMenuTarget } from './GitBranchContextMenu';
import styles from './GitWorkspace.module.css';

interface RemoteBranchGroup {
  branches: Array<{ branch: GitBranchSummary; displayName: string }>;
  remote: string;
}

interface GitBranchTreeProps {
  branches: GitBranchSummary[];
  disabled: boolean;
  selectedReference: string | null;
  onSelect: (branchReference: string) => void;
  onCheckout: (branch: GitBranchSummary) => void;
  onCreate: (branch: GitBranchSummary, branchName: string) => Promise<boolean>;
  onUpdate: (branch: GitBranchSummary) => void;
}

function groupRemoteBranches(branches: GitBranchSummary[]): RemoteBranchGroup[] {
  const groups = new Map<string, RemoteBranchGroup['branches']>();
  for (const branch of branches) {
    const separator = branch.name.indexOf('/');
    const remote = separator > 0 ? branch.name.slice(0, separator) : 'remote';
    const displayName = separator > 0 ? branch.name.slice(separator + 1) : branch.name;
    const entries = groups.get(remote) ?? [];
    entries.push({ branch, displayName });
    groups.set(remote, entries);
  }
  return [...groups.entries()]
    .map(([remote, entries]) => ({
      remote,
      branches: entries.sort((left, right) => left.displayName.localeCompare(right.displayName)),
    }))
    .sort((left, right) => left.remote.localeCompare(right.remote));
}

function branchMenuPosition(button: HTMLButtonElement): Pick<GitBranchContextMenuTarget, 'x' | 'y'> {
  const bounds = button.getBoundingClientRect();
  return { x: bounds.left + 24, y: bounds.top + bounds.height };
}

export function GitBranchTree({
  branches,
  disabled,
  selectedReference,
  onSelect,
  onCheckout,
  onCreate,
  onUpdate,
}: GitBranchTreeProps) {
  const [localExpanded, setLocalExpanded] = useState(true);
  const [remoteExpanded, setRemoteExpanded] = useState(true);
  const [collapsedRemotes, setCollapsedRemotes] = useState<ReadonlySet<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<GitBranchContextMenuTarget | null>(null);
  const [creationSource, setCreationSource] = useState<GitBranchSummary | null>(null);
  const [branchName, setBranchName] = useState('');
  const branchInputRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);

  const localBranches = useMemo(
    () => branches
      .filter((branch) => !branch.remote)
      .sort((left, right) => (
        Number(right.current) - Number(left.current) || left.name.localeCompare(right.name)
      )),
    [branches],
  );
  const remoteGroups = useMemo(() => groupRemoteBranches(
    branches.filter((branch) => branch.remote),
  ), [branches]);

  const openContextMenu = (
    branch: GitBranchSummary,
    position: Pick<GitBranchContextMenuTarget, 'x' | 'y'>,
  ): void => {
    onSelect(branch.fullName);
    setContextMenu({ branch, ...position });
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, branch: GitBranchSummary): void => {
    event.preventDefault();
    openContextMenu(branch, { x: event.clientX, y: event.clientY });
  };

  const handleBranchKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, branch: GitBranchSummary): void => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    openContextMenu(branch, branchMenuPosition(event.currentTarget));
  };

  const beginBranchCreation = (branch: GitBranchSummary): void => {
    setCreationSource(branch);
    setBranchName('');
  };

  const submitBranch = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const source = creationSource;
    const name = branchName.trim();
    if (!source || !name || creating || disabled) return;
    setCreating(true);
    try {
      if (await onCreate(source, name)) {
        setCreationSource(null);
        setBranchName('');
        onSelect(`refs/heads/${name}`);
      }
    } finally {
      setCreating(false);
    }
  };

  const toggleRemote = (remote: string): void => {
    setCollapsedRemotes((current) => {
      const next = new Set(current);
      if (next.has(remote)) next.delete(remote);
      else next.add(remote);
      return next;
    });
  };

  const renderBranch = (
    branch: GitBranchSummary,
    displayName = branch.name,
    nested = false,
    focusable = true,
  ) => {
    const trackingDescription = [
      branch.behind > 0
        ? `${branch.behind} incoming commit${branch.behind === 1 ? '' : 's'}`
        : '',
      branch.ahead > 0
        ? `${branch.ahead} outgoing commit${branch.ahead === 1 ? '' : 's'}`
        : '',
    ].filter(Boolean);
    const accessibleDescription = [
      branch.current ? 'current branch' : '',
      ...trackingDescription,
    ].filter(Boolean);

    return (
      <button
        aria-current={branch.current ? 'true' : undefined}
        aria-haspopup="menu"
        aria-label={[branch.name, ...accessibleDescription].join(', ')}
        aria-pressed={selectedReference === branch.fullName}
        className={styles.logBranchRow}
        data-context-menu-open={contextMenu?.branch.fullName === branch.fullName ? 'true' : undefined}
        data-nested={nested ? 'true' : undefined}
        data-selected={selectedReference === branch.fullName ? 'true' : undefined}
        key={branch.fullName}
        tabIndex={focusable ? undefined : -1}
        type="button"
        onClick={() => onSelect(branch.fullName)}
        onContextMenu={(event) => handleContextMenu(event, branch)}
        onKeyDown={(event) => handleBranchKeyDown(event, branch)}
      >
        <GitBranch aria-hidden="true" />
        <span className={styles.logBranchIdentity}>
          <span className={styles.logBranchName}>{displayName}</span>
          {(branch.behind > 0 || branch.ahead > 0) && (
            <span aria-hidden="true" className={styles.logBranchTracking}>
              {branch.behind > 0 && (
                <small className={styles.changeCountBadge} data-direction="behind">
                  <ArrowDown />
                  {branch.behind}
                </small>
              )}
              {branch.ahead > 0 && (
                <small className={styles.changeCountBadge} data-direction="ahead">
                  <ArrowUp />
                  {branch.ahead}
                </small>
              )}
            </span>
          )}
        </span>
        {branch.current ? <em className={styles.changeCountBadge}>Current</em> : <code className={styles.changeCountBadge}>{branch.hash}</code>}
      </button>
    );
  };

  return (
    <div className={styles.logBranches} aria-label="Repository branches">
      {creationSource && (
        <form className={styles.logBranchCreator} onSubmit={(event) => void submitBranch(event)}>
          <span>New branch from <strong>{creationSource.name}</strong></span>
          <div>
            <NeumorphicTextField
              ref={branchInputRef}
              autoFocus
              aria-label={`New branch from ${creationSource.name}`}
              disabled={disabled || creating}
              placeholder="Branch name"
              value={branchName}
              trailingAction={branchName ? (
                <SearchClearButton
                  aria-label="Clear branch name"
                  disabled={disabled || creating}
                  onClick={() => {
                    setBranchName('');
                    branchInputRef.current?.focus();
                  }}
                />
              ) : undefined}
              onChange={(event) => setBranchName(event.target.value)}
            />
            <NeumorphicButton
              size="standard"
              raised
              className="neumorphic-surface"
              disabled={disabled || creating || !branchName.trim()}
              type="submit"
            >
              Create
            </NeumorphicButton>
            <NeumorphicButton
              size="icon"
              raised
              aria-label="Cancel branch creation"
              className="neumorphic-surface"
              disabled={creating}
              type="button"
              onClick={() => {
                setCreationSource(null);
                setBranchName('');
              }}
            >
              <X aria-hidden="true" />
            </NeumorphicButton>
          </div>
        </form>
      )}

      <section className={styles.logBranchGroup}>
        <button
          aria-expanded={localExpanded}
          aria-label="Local branches"
          className={styles.logBranchGroupToggle}
          type="button"
          onClick={() => setLocalExpanded((expanded) => !expanded)}
        >
          <ChevronRight
            aria-hidden="true"
            className={styles.logBranchChevron}
            data-expanded={localExpanded ? 'true' : undefined}
          />
          <span>Local</span>
          <small className={styles.changeCountBadge}>{localBranches.length}</small>
        </button>
        <div
          aria-hidden={!localExpanded}
          className={styles.logBranchChildren}
          data-expanded={localExpanded ? 'true' : 'false'}
          data-branch-children="local"
          role="group"
          aria-label="Local branches"
        >
          <div>
            {localBranches.map((branch) => renderBranch(branch, branch.name, false, localExpanded))}
            {localBranches.length === 0 && <span className={styles.logBranchEmpty}>No local branches</span>}
          </div>
        </div>
      </section>

      <section className={styles.logBranchGroup}>
        <button
          aria-expanded={remoteExpanded}
          aria-label="Remote branches"
          className={styles.logBranchGroupToggle}
          type="button"
          onClick={() => setRemoteExpanded((expanded) => !expanded)}
        >
          <ChevronRight
            aria-hidden="true"
            className={styles.logBranchChevron}
            data-expanded={remoteExpanded ? 'true' : undefined}
          />
          <span>Remote</span>
          <small className={styles.changeCountBadge}>{remoteGroups.reduce((count, group) => count + group.branches.length, 0)}</small>
        </button>
        <div
          aria-hidden={!remoteExpanded}
          className={styles.logBranchChildren}
          data-expanded={remoteExpanded ? 'true' : 'false'}
          data-branch-children="remote"
          role="group"
          aria-label="Remote branches"
        >
          <div>
            {remoteGroups.map((group) => {
              const expanded = !collapsedRemotes.has(group.remote);
              return (
                <div className={styles.logRemoteGroup} key={group.remote}>
                  <button
                    aria-expanded={expanded}
                    className={styles.logRemoteToggle}
                    tabIndex={remoteExpanded ? undefined : -1}
                    type="button"
                    onClick={() => toggleRemote(group.remote)}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={styles.logBranchChevron}
                      data-expanded={expanded ? 'true' : undefined}
                    />
                    <FolderGit2 aria-hidden="true" />
                    <span>{group.remote}</span>
                  </button>
                  <div
                    aria-hidden={!expanded}
                    className={styles.logBranchChildren}
                    data-expanded={expanded ? 'true' : 'false'}
                    data-branch-children={`remote:${group.remote}`}
                  >
                    <div>
                      {group.branches.map(({ branch, displayName }) => renderBranch(
                        branch,
                        displayName,
                        true,
                        remoteExpanded && expanded,
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            {remoteGroups.length === 0 && <span className={styles.logBranchEmpty}>No remote branches</span>}
          </div>
        </div>
      </section>

      {contextMenu && (
        <GitBranchContextMenu
          {...contextMenu}
          disabled={disabled}
          onCheckout={onCheckout}
          onClose={() => setContextMenu(null)}
          onCreateFrom={beginBranchCreation}
          onUpdate={onUpdate}
        />
      )}
    </div>
  );
}
