import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { parseProjectDocMaxBytes, type SettingsApi } from '../../../../shared/settings';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SettingsView.module.css';

export function AgentSettings({ api }: { api?: SettingsApi }) {
  const [bytes, setBytes] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const receive = (value: number) => { setBytes(value); setDraft(String(value / 1024)); };
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const current = ++revision.current;
    setBytes(null); setDraft(''); setError(null); setNotice(null);
    const unsubscribe = api?.onProjectDocMaxBytesChanged(value => {
      if (disposed) return;
      revision.current++; receive(value); setNotice(null); setError(null);
    });
    void api?.getProjectDocMaxBytes().then(value => {
      if (!disposed && revision.current === current) receive(value);
    }).catch(() => {
      if (!disposed && revision.current === current) setError('Could not load the instruction size limit.');
    });
    return () => { disposed = true; mounted.current = false; revision.current++; unsubscribe?.(); };
  }, [api]);
  const save = async () => {
    if (!api || bytes === null || pending.current) return;
    let next: number;
    try { next = parseProjectDocMaxBytes(Number(draft) * 1024); }
    catch (cause) { setError((cause as Error).message); return; }
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    const current = revision.current;
    try {
      const saved = await api.setProjectDocMaxBytes(next);
      if (mounted.current && revision.current === current) { revision.current++; receive(saved); }
      if (mounted.current) setNotice('Saved. Reopen the workspace and restart Homies to apply.');
    } catch {
      if (mounted.current && revision.current === current) setError('Could not save the instruction size limit. Try again.');
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className={styles.detail} aria-labelledby="agent-settings-heading">
    <div className={styles.scroll}>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className={styles.titleRow}><h2 id="agent-settings-heading" className={styles.sectionTitle}>Project instructions</h2></div>
        <p className={styles.description}>Maximum combined size of project and subdirectory instructions. Default: 32 KiB.</p>
        <div className={styles.settingRow}>
          <label className={styles.settingLabel} htmlFor="project-doc-limit">Instruction size limit (KiB)</label>
          <div className={styles.actions}>
            <NeumorphicTextField id="project-doc-limit" className={styles.instructionLimit} variant="standard" type="number" min="1" step="1"
              value={draft} disabled={!api || bytes === null || busy} onChange={event => { setDraft(event.target.value); setError(null); setNotice(null); }} />
            <NeumorphicButton type="submit" raised size="icon" aria-label="Save instruction size limit"
              disabled={!api || bytes === null || busy || Number(draft) * 1024 === bytes}><Save aria-hidden="true" /></NeumorphicButton>
          </div>
        </div>
        <p className={styles.description}>Applies to local Codex sessions and Docker Homies across all workspaces. Reopen the workspace and restart Homies after changing this setting. Running tasks are not interrupted.</p>
        {!api ? <p role="status" className={styles.description}>Agent settings are available in the Cheshi desktop app.</p>
          : bytes === null && !error ? <p role="status" className={styles.description}>Loading settings…</p> : null}
        {notice && <p role="status" className={styles.description}>{notice}</p>}
        {error && <p role="alert" className={styles.description}>{error}</p>}
      </form>
    </div>
  </section>;
}
