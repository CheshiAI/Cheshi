import { useRef, useState } from 'react';
import { FolderOpen, FolderPlus } from 'lucide-react';

import type { WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { LoadingState, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../../shared/ui';
import { WorkspaceManagerHeader } from './WorkspaceManagerHeader';
import { useWorkspaceOperation } from './useWorkspaceOperation';
import { childDirectory, parentDirectory, validDirectoryName, workspaceError } from './workspace-paths';
import managerStyles from './WorkspaceManager.module.css';
import styles from './workspace-management.module.css';

export function CreateProjectProgress({ opening, onBack }: { opening: boolean; onBack(): void }) {
  return <>
    <WorkspaceManagerHeader title="Create project" icon={<FolderPlus />} busy onBack={onBack} />
    <main className={`${managerStyles.page} ${styles.preparingPage}`} aria-label="Create project progress">
      <div className={styles.cloneProgress}>
        <LoadingState type={opening ? 'preparing' : 'processing'} />
        <p className={styles.hint} role="status">{opening
          ? 'Project created. Opening workspace…'
          : 'Creating project and initializing Git…'}</p>
      </div>
    </main>
  </>;
}

export function CreateProjectWorkspacePage({ api, currentPath, onClose }: {
  api: WorkspaceManagementApi;
  currentPath: string;
  onClose(): void;
}) {
  const [parentPath, setParentPath] = useState(() => parentDirectory(currentPath));
  const [directoryName, setDirectoryName] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const pending = useRef(false);
  const parentInput = useRef<HTMLInputElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const operation = useWorkspaceOperation(api, onClose);
  const busy = choosing || operation.busy;
  const valid = parentPath.trim().length > 0 && validDirectoryName(directoryName);
  const fieldsDisabled = busy || operation.created !== null;

  const choose = async (): Promise<void> => {
    if (pending.current || operation.created) return;
    pending.current = true;
    setChoosing(true);
    setChooseError(null);
    try {
      const selected = await api.chooseDirectory();
      if (selected) setParentPath(selected);
    } catch (error) {
      setChooseError(workspaceError(error));
    } finally {
      pending.current = false;
      setChoosing(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (pending.current || (!valid && !operation.created)) return;
    pending.current = true;
    setChooseError(null);
    try {
      await operation.run(() => api.createProject({
        parentPath: parentPath.trim(), directoryName: directoryName.trim(),
      }));
    } finally {
      pending.current = false;
    }
  };

  if (operation.busy) return <CreateProjectProgress opening={operation.created !== null} onBack={onClose} />;

  return <>
    <WorkspaceManagerHeader title="Create project" icon={<FolderPlus />} busy={busy} onBack={onClose} />
    <main className={managerStyles.page} aria-label="Create project">
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className={styles.hint}>Create a new project folder with a local Git repository.</p>
        <fieldset disabled={fieldsDisabled} className={styles.fields}>
          <label>
            <span className={styles.fieldLabel}>Parent folder</span>
            <div className={styles.folderField}>
              <NeumorphicTextField ref={parentInput} required value={parentPath}
                onChange={(event) => setParentPath(event.target.value)}
                trailingAction={parentPath ? <SearchClearButton aria-label="Clear parent folder" disabled={fieldsDisabled}
                  onClick={() => { setParentPath(''); parentInput.current?.focus(); }} /> : undefined} />
              <NeumorphicButton raised size="standard" onClick={() => void choose()} aria-label="Choose project parent folder">
                <FolderOpen aria-hidden="true" />Browse
              </NeumorphicButton>
            </div>
          </label>
          <label>
            <span className={styles.fieldLabel}>Project name</span>
            <NeumorphicTextField ref={nameInput} autoFocus required value={directoryName} placeholder="my-project"
              onChange={(event) => setDirectoryName(event.target.value)}
              trailingAction={directoryName ? <SearchClearButton aria-label="Clear project name" disabled={fieldsDisabled}
                onClick={() => { setDirectoryName(''); nameInput.current?.focus(); }} /> : undefined} />
          </label>
        </fieldset>
        {operation.created && <p role="status" className={styles.hint}>
          Project ready at {operation.created.rootPath}. Retry opening it without creating it again.
        </p>}
        {(operation.error || chooseError) && <p role="alert" className={styles.error}>{operation.error || chooseError}</p>}
        {choosing && <p role="status" className={styles.hint}>Choosing folder…</p>}
        <footer className={styles.splitFooter}>
          <p className={`${styles.path} ${styles.footerDetails}`}>
            {parentPath.trim() && directoryName.trim() ? childDirectory(parentPath.trim(), directoryName.trim()) : 'Choose a parent folder and enter a project name.'}
          </p>
          <div className={styles.footer}>
            <NeumorphicButton raised size="standard" disabled={busy} onClick={onClose}>Cancel</NeumorphicButton>
            <NeumorphicButton raised size="standard" type="submit" disabled={busy || (!valid && !operation.created)}>
              <FolderPlus aria-hidden="true" />{operation.created ? 'Open in new window' : 'Create and open'}
            </NeumorphicButton>
          </div>
        </footer>
      </form>
    </main>
  </>;
}
