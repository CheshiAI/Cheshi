import { useEffect, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, Folders, GitBranch, GitFork, Search, Trash2 } from 'lucide-react';
import type { WorkspaceCatalogEntry, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { NeumorphicButton, NeumorphicTextField, SearchClearButton, WorkspaceProjectIcon } from '../../../shared/ui';
import { isLiteralTrue } from '../../../shared/isLiteralTrue';
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

export async function runWorkspaceDeletion(pending: { current: boolean }, api: Pick<WorkspaceManagementApi, 'deleteWorkspace'>,
  id: string, onDeleted: () => void): Promise<boolean> {
  if (pending.current) return false;
  pending.current = true;
  try {
    if (!isLiteralTrue(await api.deleteWorkspace(id))) return false;
    onDeleted();
    return true;
  } finally { pending.current = false; }
}

export function WorkspaceProjectList({ entries, selectedPath, busy, onSelect, onOpen, onDelete }: {
  entries: WorkspaceCatalogEntry[];
  selectedPath: string;
  busy: boolean;
  onSelect: (path: string) => void;
  onOpen: (entry: WorkspaceCatalogEntry, trigger: HTMLButtonElement) => void;
  onDelete: (entry: WorkspaceCatalogEntry) => void;
}) {
  return <ul className={styles.projects} aria-label="Registered projects">
    {entries.map((entry) => <li key={entry.id} className={styles.projectRow}>
      <NeumorphicButton className={styles.project} disabled={busy || !entry.available}
        data-selected={entry.rootPath === selectedPath ? 'true' : undefined}
        aria-label={`Open ${entry.name}${entry.available ? '' : ' — unavailable'}`}
        title={entry.rootPath} onFocus={() => onSelect(entry.rootPath)} onClick={(event) => onOpen(entry, event.currentTarget)}>
        <WorkspaceProjectIcon name={entry.name} rootPath={entry.rootPath} />
        <span className={styles.projectCopy}>
          <strong>{entry.name}</strong>
          <span>{entry.rootPath}</span>
          {!entry.available && <small>Folder unavailable</small>}
        </span>
      </NeumorphicButton>
      <NeumorphicButton raised size="icon" className={styles.deleteProject} disabled={busy}
        aria-label={`Delete ${entry.name} workspace and folder`} title={`Move ${entry.rootPath} to Trash and remove from Workspaces`}
        onClick={() => onDelete(entry)}><Trash2 aria-hidden="true" /></NeumorphicButton>
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
  const [toolsChecked, setToolsChecked] = useState(false);
  const [loginChecked, setLoginChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const workspaceReady = toolsReady && authenticated && prepared;
  const initialContentReady = toolsChecked && (!toolsReady || (loginChecked && (!authenticated || prepared)));
  useEffect(() => {
    if (initialContentReady) window.dispatchEvent(new Event('cheshi:workspace-content-ready'));
  }, [initialContentReady]);
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
    setStatus('Opening workspace…');
    try { await action(); }
    catch (cause) { setActionError(workspaceError(cause)); setStatus(null); }
    finally { pending.current = false; setBusy(false); }
  };
  const open = (entry: WorkspaceCatalogEntry, trigger: HTMLButtonElement): void => {
    dialogTrigger.current = trigger;
    setSelectedPath(entry.rootPath);
    setOpeningEntry(entry);
    setActionError(null);
    setStatus(null);
  };
  const openFolder = (): void => {
    void run(async () => {
      const path = await api.chooseDirectory();
      if (!path) { setStatus(null); return; }
      const entry = await api.addFolder(path);
      setEntries((previous) => [entry, ...previous.filter((item) => item.id !== entry.id)]);
      setSelectedPath(entry.rootPath);
      await api.open(entry.rootPath);
      setStatus(`${entry.name} opened in a new window.`);
    });
  };
  const deleteWorkspace = (entry: WorkspaceCatalogEntry): void => {
    if (pending.current) return;
    setBusy(true);
    setActionError(null);
    setStatus('Waiting for deletion confirmation…');
    void runWorkspaceDeletion(pending, api, entry.id, () => {
      setEntries((previous) => previous.filter((item) => item.id !== entry.id));
      setSelectedPath((previous) => previous === entry.rootPath ? workspaceRoot : previous);
      setStatus(`${entry.name} removed from Workspaces.`);
    }).then((deleted) => { if (!deleted) setStatus(null); })
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

  return <div className={styles.manager} data-platform={platform}>
    <div className={styles.home} hidden={mode !== null}>
      <WorkspaceManagerHeader title="Workspaces" icon={<Folders />} />
      <div className={styles.layout}>
        <main className={styles.content}>
          {workspaceReady && <div className={styles.toolbar}>
            <div className={styles.searchField}>
              <Search aria-hidden="true" />
              <NeumorphicTextField type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                aria-label="Search projects" placeholder="Search projects"
                trailingAction={query ? <SearchClearButton aria-label="Clear project search" onClick={() => setQuery('')} /> : undefined} />
            </div>
            <div className={styles.actions}>
              <NeumorphicButton raised size="standard" disabled={busy} onClick={openFolder}><FolderOpen aria-hidden="true" />Open folder</NeumorphicButton>
              <NeumorphicButton raised size="standard" disabled={busy} onClick={(event) => showDialog('clone', event.currentTarget)}><GitFork aria-hidden="true" />Clone repository</NeumorphicButton>
              <NeumorphicButton raised size="standard" disabled={!canOpenWorktrees} title={`Worktrees for ${selected?.name ?? workspaceName}`}
                onClick={(event) => showDialog('worktrees', event.currentTarget)}><GitBranch aria-hidden="true" />Git worktrees</NeumorphicButton>
            </div>
          </div>}
          {workspaceReady && loadError && <div className={styles.errorBox}>
            <p role="alert">{loadError}</p>
            <NeumorphicButton raised size="standard" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Retry loading projects</NeumorphicButton>
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
              onSelect={setSelectedPath} onOpen={open} onDelete={deleteWorkspace} />
            </>}
            {toolsReady && <WorkspaceCodexLogin api={api} ready={workspaceReady} onAuthenticatedChange={setAuthenticated} onSettledChange={setLoginChecked} />}
            <WorkspaceToolSetup api={api} platform={platform} onReadyChange={setToolsReady} onSettledChange={setToolsChecked} />
          </section>
        </main>
      </div>
      <footer className={styles.status}>
        <span role="status">{workspaceReady ? status ?? `${entries.length} ${entries.length === 1 ? 'project' : 'projects'}` : null}</span>
        {workspaceReady && <div className={styles.actions}>
          <NeumorphicButton raised size="standard" disabled={busy} onClick={(event) => showDialog('create', event.currentTarget)}>
            <FolderPlus aria-hidden="true" />Create project
          </NeumorphicButton>
        </div>}
      </footer>
    </div>
    {mode === 'create' && <CreateProjectWorkspacePage api={api} currentPath={contextPath} onClose={closeDialog} />}
    {mode === 'clone' && <PrepareCloneWorkspacePage api={api} currentPath={contextPath} onClose={closeDialog} />}
    {mode === 'worktrees' && <WorktreeWorkspacePage api={api} currentPath={contextPath} onClose={closeDialog} />}
    {openingEntry && <OpenWorkspaceDialog api={api} entry={openingEntry} currentPath={workspaceRoot}
      onClose={() => setOpeningEntry(null)} restoreFocus={() => { dialogTrigger.current?.focus(); return false; }} />}
  </div>;
}
