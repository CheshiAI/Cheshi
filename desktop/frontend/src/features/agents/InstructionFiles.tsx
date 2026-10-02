import { useEffect, useRef, useState } from 'react';
import { FileText, Unlink } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui';
import { parseInstructionFiles } from '../../../../shared/agent-registry';
import type { AgentRegistryModel } from './agentRegistryModel';
import styles from './InstructionFiles.module.css';

export function InstructionFiles({ label, paths, model, disabled, onChange, onBusy }: {
  label: string; paths: string[]; model: AgentRegistryModel; disabled: boolean;
  onChange: (paths: string[]) => void; onBusy: (busy: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const perform = async (operation: () => Promise<void>) => {
    if (disabled || pending.current) return;
    pending.current = true; onBusy(true); setError(null);
    try { await operation(); }
    catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : 'Could not access instruction files.'); }
    finally { pending.current = false; if (active.current) onBusy(false); }
  };
  return <section className={styles.files} aria-label={label}>
    <div className={styles.heading}><span>{label}</span>
      <NeumorphicButton type="button" variant="ghost" disabled={disabled} aria-label={`Link ${label.toLowerCase()}`}
        onClick={() => void perform(async () => {
          const selected = await model.selectInstructionFiles();
          if (active.current && selected.length) onChange(parseInstructionFiles([...new Set([...paths, ...selected])]));
        })}>Link MD files</NeumorphicButton></div>
    {paths.map(path => <div className={styles.file} key={path}>
      <FileText aria-hidden="true" />
      <div className={styles.identity}><span>{path.split(/[\\/]/).at(-1)}</span><span className={styles.path}>{path}</span></div>
      <NeumorphicButton type="button" variant="ghost" disabled={disabled} aria-label={`Open ${path}`}
        onClick={() => void perform(() => model.openInstructionFile(path))}>Open</NeumorphicButton>
      <NeumorphicButton type="button" variant="ghost" size="icon" disabled={disabled} title="Unlink file" aria-label={`Unlink ${path}`}
        onClick={() => { setError(null); onChange(paths.filter(value => value !== path)); }}><Unlink aria-hidden="true" /></NeumorphicButton>
    </div>)}
    <p className={styles.description}>Original files are read when the worker starts. Restart the worker to apply file changes.</p>
    {error && <p role="alert" className={styles.description}>{error}</p>}
  </section>;
}
