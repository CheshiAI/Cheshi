import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, Folders, GitBranch, GitFork, X, PackageOpen } from 'lucide-react';
import type { WorkspaceCatalogEntry, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { LoadingState, NeumorphicButton, WorkspaceProjectIcon } from '../../../shared/ui';
import { SearchInput } from '../../../shared/ui/SearchInput';
import { isLiteralTrue } from '../../../shared/isLiteralTrue';
import { AppUpdateIndicator } from '../../updates/AppUpdateIndicator';
import { PrepareCloneWorkspacePage } from './PrepareCloneWorkspacePage';
import { CreateProjectWorkspacePage } from './CreateProjectWorkspacePage';
import { WorktreeWorkspacePage } from './WorktreeWorkspacePage';
import { OpenWorkspaceDialog } from './OpenWorkspaceDialog';
import { WorkspaceManagerHeader } from './WorkspaceManagerHeader';
import { WorkspaceToolSetup } from './WorkspaceToolSetup';
import { WorkspaceCodexLogin } from './WorkspaceCodexLogin';
import { workspaceError } from './workspace-paths';
import styles from './WorkspaceManager.module.css';

export function filterWorkspaceEntries(entries: WorkspaceCatalogEntry[], query: string): WorkspaceCatalogEntry[] {
  const search = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => `${entry.name}\n${entry.rootPath}`.toLocaleLowerCase().includes(search));
}

export function canOpenWorkspaceWorktrees(entries: WorkspaceCatalogEntry[], contextPath: string, blocked: boolean): boolean {
  return !blocked && entries.some((entry) => entry.rootPath === contextPath
    && isLiteralTrue(entry.available) && isLiteralTrue(entry.isGitRepository));
}

export async function runWorkspaceRemoval(pending: { current: boolean }, api: Pick<WorkspaceManagementApi, 'removeWorkspace'>,
  id: string, onRemoved: () => void): Promise<boolean> {
  if (pending.current) return false;
  pending.current = true;
  try {
    if (!isLiteralTrue(await api.removeWorkspace(id))) return false;
    onRemoved();
    return true;
  } finally { pending.current = false; }
}

export function WorkspaceProjectList({ entries, selectedPath, busy, onSelect, onOpen, onRemove, onOpenOptions }: {
  entries: WorkspaceCatalogEntry[];
  selectedPath: string;
  busy: boolean;
  onSelect: (path: string) => void;
  onOpen: (entry: WorkspaceCatalogEntry, trigger: HTMLButtonElement) => void;
  onRemove: (entry: WorkspaceCatalogEntry) => void;
  onOpenOptions?: (entry: WorkspaceCatalogEntry, trigger: HTMLButtonElement) => void;
}) {
  return <ul className={styles.projects} aria-label="Registered projects">
    {entries.map((entry) => <li key={entry.id} className={styles.projectRow} data-open-options={Boolean(onOpenOptions)}>
      <NeumorphicButton variant="ghost" className={styles.project} disabled={busy || !entry.available}
        data-selected={entry.rootPath === selectedPath ? 'true' : undefined}
        aria-label={`Open ${entry.name}${entry.available ? '' : ' — unavailable'}`}
        title={entry.rootPath} onFocus={() => onSelect(entry.rootPath)} onClick={(event) => onOpen(entry, event.currentTarget)}>
        <WorkspaceProjectIcon name={entry.name} color={entry.iconColor} />
        <span className={styles.projectCopy}>
          <strong>{entry.name}</strong>
          <span>{entry.rootPath}</span>
          {!entry.available && <small>Folder unavailable</small>}
        </span>
      </NeumorphicButton>
      <div className={styles.projectActions}>
        {onOpenOptions && <NeumorphicButton variant="ghost" size="icon" disabled={busy || !entry.available}
          aria-label={`Open options for ${entry.name}`} title="Workspace options"
          onClick={event => onOpenOptions(entry, event.currentTarget)}><PackageOpen aria-hidden="true" /></NeumorphicButton>}
        <NeumorphicButton variant="ghost" size="icon" disabled={busy}
          aria-label={`Remove ${entry.name} from Workspaces`} title="Remove from list; keep folder and data"
          onClick={() => onRemove(entry)}><X aria-hidden="true" /></NeumorphicButton>
      </div>
    </li>)}
  </ul>;
}

export function WorkspaceManager({ api, workspaceName, workspaceRoot, platform }: {
  api: WorkspaceManagementApi;
  workspaceName: string;
  workspaceRoot: string;
  platform: string;
}) {
  const [entries, setEntries] = useState<WorkspaceCatalogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState(workspaceRoot);
  const [loading, setLoading] = useState(true);
  const [toolsReady, setToolsReady] = useState(platform !== 'darwin');
  const [authenticated, setAuthenticated] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [loginActionsTarget, setLoginActionsTarget] = useState<HTMLDivElement | null>(null);
  const workspaceReady = toolsReady && authenticated && prepared;
  useEffect(() => {
    window.dispatchEvent(new Event('cheshi:workspace-content-ready'));
  }, []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<'create' | 'clone' | 'worktrees' | null>(null);
  const [openingEntry, setOpeningEntry] = useState<WorkspaceCatalogEntry | null>(null);
  const pending = useRef(false);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const listRegion = useRef<HTMLElement | null>(null);
  const savedListScroll = useRef(0);

  useEffect(() => {
    if (!toolsReady || !authenticated) {
      setPrepared(false);
      setMode(null);
      setOpeningEntry(null);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    void api.list().then((catalog) => { if (active) setEntries(catalog.workspaces); })
      .catch((cause: unknown) => { if (active) setLoadError(workspaceError(cause)); })
      .finally(() => { if (active) { setLoading(false); setPrepared(true); } });
    return () => { active = false; };
  }, [api, refresh, toolsReady, authenticated]);

  useEffect(() => {
    const refreshOnFocus = (): void => { if (!pending.current) setRefresh((value) => value + 1); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, []);

  useEffect(() => {
    if (mode === null) {
      if (listRegion.current) listRegion.current.scrollTop = savedListScroll.current;
      dialogTrigger.current?.focus({ preventScroll: true });
    }
  }, [mode]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    setStatus(null);
    try { await action(); }
    catch (cause) { setActionError(workspaceError(cause)); setStatus(null); }
    finally { pending.current = false; setBusy(false); }
  };
  const operationApi = useMemo(() => ({ ...api, open: (path: string) => workspaceRoot ? api.openCurrent(path) : api.open(path) }), [api, workspaceRoot]);
  const openOptions = (entry: WorkspaceCatalogEntry, trigger: HTMLButtonElement): void => {
    dialogTrigger.current = trigger;
    setSelectedPath(entry.rootPath);
    setOpeningEntry(entry);
    setActionError(null);
    setStatus(null);
  };
  const open = (entry: WorkspaceCatalogEntry): void => {
    setSelectedPath(entry.rootPath);
    void run(async () => { setStatus('Opening workspace…'); await operationApi.open(entry.rootPath); });
  };
  const openFolder = (): void => {
    void run(async () => {
      const path = await api.chooseDirectory();
      if (!path) { setStatus(null); return; }
      setStatus('Opening workspace…');
      const entry = await api.addFolder(path);
      setEntries((previous) => [entry, ...previous.filter((item) => item.id !== entry.id)]);
      setSelectedPath(entry.rootPath);
      await operationApi.open(entry.rootPath);
      setStatus(`${entry.name} opened.`);
    });
  };
  const removeWorkspace = (entry: WorkspaceCatalogEntry): void => {
    if (pending.current) return;
    setBusy(true);
    setActionError(null);
    setStatus('Waiting for removal confirmation…');
    void runWorkspaceRemoval(pending, api, entry.id, () => {
      setEntries((previous) => previous.filter((item) => item.id !== entry.id));
      setSelectedPath((previous) => previous === entry.rootPath ? workspaceRoot : previous);
      setStatus(`${entry.name} removed from Workspaces.`);
    }).then((removed) => { if (!removed) setStatus(null); })
      .catch((cause: unknown) => { setActionError(workspaceError(cause)); setStatus(null); })
      .finally(() => setBusy(false));
  };
  const showDialog = (nextMode: 'create' | 'clone' | 'worktrees', trigger: HTMLButtonElement): void => {
    if (nextMode === 'worktrees' && !canOpenWorktrees) return;
    dialogTrigger.current = trigger;
    savedListScroll.current = listRegion.current?.scrollTop ?? 0;
    setMode(nextMode);
    setActionError(null);
    setStatus(null);
  };
  const closeDialog = (): void => {
    setMode(null);
    setRefresh((value) => value + 1);
  };
  const selected = entries.find((entry) => entry.rootPath === selectedPath && entry.available);
  const contextPath = selected?.rootPath ?? workspaceRoot;
  const canOpenWorktrees = canOpenWorkspaceWorktrees(entries, contextPath, loading || busy || loadError !== null);
  const filtered = filterWorkspaceEntries(entries, query);

  return <div className={`window-appearance-surface ${styles.manager}`} data-platform={platform}>
    <div className={styles.home} hidden={mode !== null}>
      <WorkspaceManagerHeader title="Workspaces" icon={<Folders />} />
      <div className={styles.layout}>
        <main className={styles.content}>
          {workspaceReady && <div className={styles.toolbar}>
            <SearchInput className={styles.searchField} value={query} onChange={(event) => setQuery(event.target.value)}
              aria-label="Search projects" clearLabel="Clear project search" onClear={() => setQuery('')} />
            <div className={styles.actions}>
              <NeumorphicButton variant="standard" disabled={busy} onClick={openFolder}><FolderOpen aria-hidden="true" />Open folder</NeumorphicButton>
              <NeumorphicButton variant="standard" disabled={busy} onClick={(event) => showDialog('clone', event.currentTarget)}><GitFork aria-hidden="true" />Clone repository</NeumorphicButton>
              <NeumorphicButton variant="standard" disabled={!canOpenWorktrees} title={`Worktrees for ${selected?.name ?? workspaceName}`}
                onClick={(event) => showDialog('worktrees', event.currentTarget)}><GitBranch aria-hidden="true" />Git worktrees</NeumorphicButton>
            </div>
          </div>}
          {workspaceReady && loadError && <div className={styles.errorBox}>
            <p role="alert">{loadError}</p>
            <NeumorphicButton variant="standard" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Retry loading projects</NeumorphicButton>
          </div>}
          {workspaceReady && actionError && <p role="alert" className={styles.error}>{actionError}</p>}
          <section ref={listRegion} className={styles.listRegion} aria-label="Projects" aria-busy={authenticated && loading}>
            {workspaceReady && <>
            {loading && entries.length === 0 && <p role="status" className={styles.empty}>Loading projects…</p>}
            {!loading && !loadError && entries.length === 0 && <div className={styles.empty}>
              <Folders aria-hidden="true" /><h2>Your next workspace starts here</h2>
              <p>Create a project, open a local folder, or clone a repository to get started.</p>
            </div>}
            {entries.length > 0 && filtered.length === 0 && <p role="status" className={styles.empty}>No projects match “{query}”.</p>}
            <WorkspaceProjectList entries={filtered} selectedPath={selectedPath} busy={busy || loading}
              onSelect={setSelectedPath} onOpen={open} onOpenOptions={openOptions} onRemove={removeWorkspace} />
            </>}
            {toolsReady && <WorkspaceCodexLogin api={api} ready={workspaceReady} actionsTarget={loginActionsTarget}
              onAuthenticatedChange={setAuthenticated} />}
            <WorkspaceToolSetup api={api} platform={platform} onReadyChange={setToolsReady} />
          </section>
        </main>
      </div>
      <footer className={styles.status}>
        {workspaceReady && busy && status !== null ? <LoadingState type="preparing" label={status} />
          : <span role="status">{workspaceReady ? status ?? `${entries.length} ${entries.length === 1 ? 'project' : 'projects'}` : null}</span>}
        <AppUpdateIndicator api={api} />
        {workspaceReady && <div className={styles.actions}>
          <NeumorphicButton variant="standard" disabled={busy} onClick={(event) => showDialog('create', event.currentTarget)}>
            <FolderPlus aria-hidden="true" />Create project
          </NeumorphicButton>
        </div>}
        {toolsReady && !workspaceReady && <div ref={setLoginActionsTarget} className={styles.loginActions}
          role="group" aria-label="Sign-in actions" />}
      </footer>
    </div>
    {mode === 'create' && <CreateProjectWorkspacePage api={operationApi} currentPath={contextPath} onClose={closeDialog} />}
    {mode === 'clone' && <PrepareCloneWorkspacePage api={operationApi} currentPath={contextPath} onClose={closeDialog} />}
    {mode === 'worktrees' && <WorktreeWorkspacePage api={operationApi} currentPath={contextPath} onClose={closeDialog} />}
    {openingEntry && <OpenWorkspaceDialog api={api} entry={openingEntry} currentPath={workspaceRoot}
      onDeleted={() => { setOpeningEntry(null); setRefresh(value => value + 1); }}
      onClose={() => setOpeningEntry(null)} restoreFocus={() => { dialogTrigger.current?.focus(); return false; }} />}
  </div>;
}
