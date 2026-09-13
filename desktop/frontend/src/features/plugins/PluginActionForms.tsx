import { invalidateSkillCatalog, trackSkillCatalogWorkflow } from '../../shared/skillCatalogChanges';
import { useRef, useState } from 'react';

import { cheshiDesktop } from '../../cheshiDesktop';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './PluginActionForms.module.css';

export interface PluginWorkflowFormProps {
  chatContextId?: string;
  onBusyChange: (busy: boolean) => void;
  onStarted: (threadId: string) => void;
}

export function usePluginAction(onBusyChange: (busy: boolean) => void) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  return { busy, error, run };
}

export function pluginDesktop() {
  if (!cheshiDesktop) throw new Error('Open Cheshi Desktop to use this feature.');
  return cheshiDesktop;
}

export function PluginCreateForm({ chatContextId, onBusyChange, onStarted }: PluginWorkflowFormProps) {
  const [description, setDescription] = useState('');
  const { busy, error, run } = usePluginAction(onBusyChange);
  return (
    <form className={styles.form} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const result = await pluginDesktop().startPluginWorkflow({ kind: 'plugin', description }, chatContextId);
        trackSkillCatalogWorkflow(result.threadId);
        onStarted(result.threadId);
      });
    }}>
      <label className={styles.field}>
        Description
        <NeumorphicTextField multiline autoFocus required maxLength={16_000} rows={3} value={description} disabled={busy}
          placeholder="Describe the skills and tools your plugin needs."
          onChange={(event) => setDescription(event.target.value)} />
      </label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.footer}>
        <p className={styles.hint}>Creates files in a new chat. Extra access requires approval.</p>
        <div className={styles.actions}>
          <NeumorphicButton raised type="submit" disabled={busy || !description.trim()}>{busy ? 'Starting…' : 'Create plugin'}</NeumorphicButton>
        </div>
      </div>
    </form>
  );
}

interface MarketplaceAddFormProps {
  onBusyChange: (busy: boolean) => void;
  onAdded: () => Promise<void>;
  onDone: () => void;
}

export function MarketplaceAddForm({ onBusyChange, onAdded, onDone }: MarketplaceAddFormProps) {
  const [source, setSource] = useState('');
  const [refName, setRefName] = useState('');
  const [folders, setFolders] = useState('');
  const [registered, setRegistered] = useState('');
  const { busy, error, run } = usePluginAction(onBusyChange);
  return (
    <form className={styles.form} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        if (!registered) {
          const sparsePaths = folders.split(/\r?\n/).map((folder) => folder.trim()).filter(Boolean);
          const result = await pluginDesktop().addCodexMarketplace({
            source,
            ...(refName.trim() ? { refName } : {}),
            ...(sparsePaths.length ? { sparsePaths } : {}),
          });
          invalidateSkillCatalog();
          setRegistered(`${result.marketplaceName} ${result.alreadyAdded ? 'is already registered' : 'was added'}.`);
        }
        await onAdded();
      });
    }}>
      <label className={styles.field}>
        Marketplace source
        <NeumorphicTextField autoFocus required maxLength={4096} value={source} disabled={busy || !!registered}
          placeholder="owner/repository, Git URL, or local path" onChange={(event) => setSource(event.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldHeading}>Branch, tag, or commit <span className={styles.optional}>Optional</span></span>
        <NeumorphicTextField maxLength={256} value={refName} disabled={busy || !!registered} placeholder="e.g. main, v1.0.0, or a commit hash"
          onChange={(event) => setRefName(event.target.value)} />
        <span className={styles.hint}>For Git repositories. Leave empty to use the source's ref or default branch.</span>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldHeading}>Repository folders <span className={styles.optional}>Optional</span></span>
        <NeumorphicTextField multiline maxLength={16_000} rows={2} value={folders} disabled={busy || !!registered}
          placeholder={'plugins/my-plugin\nshared/tools'} onChange={(event) => setFolders(event.target.value)} />
        <span className={styles.hint}>For Git repositories. Fetch only these folders, one relative path per line. Leave empty to fetch the full repository.</span>
      </label>
      {registered && <p className={styles.message} role="status">{registered}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.footer}>
        <p className={styles.hint}>Use a repository or folder with a Codex marketplace.</p>
        <div className={styles.actions}>
          {registered && !error && !busy
            ? <NeumorphicButton raised onClick={onDone}>Done</NeumorphicButton>
            : <NeumorphicButton raised type="submit" disabled={busy || !source.trim()}>{busy ? 'Adding…' : registered ? 'Refresh catalog' : 'Add marketplace'}</NeumorphicButton>}
        </div>
      </div>
    </form>
  );
}
