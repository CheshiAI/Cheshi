import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HomieSourceState } from '../../../../shared/homie-source';
import type { AgentRegistryModel } from './agentRegistryModel';
import { NeumorphicButton } from '../../shared/ui';
import styles from './SpecialistAgentForm.module.css';
import layout from './HomieSettings.module.css';

export function HomieSourcePanel({ active: visible = true, actionsTarget, agentId, engineId, model, disabled, onBusy }: {
  active?: boolean;
  actionsTarget?: HTMLElement | null;
  agentId: string; engineId?: string | null; model: AgentRegistryModel; disabled: boolean; onBusy(value: boolean): void;
}) {
  const [source, setSource] = useState<HomieSourceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(false), active = useRef(false), generation = useRef(0);
  useEffect(() => {
    if (!visible) return;
    active.current = true;
    let canceled = false;
    const poll = async () => {
      if (canceled || operation.current) return;
      const request = ++generation.current;
      try {
        const next = await model.source({ agentId, action: 'status', ...(engineId ? { engineId } : {}) });
        if (!canceled && request === generation.current) { setSource(next); setError(null); }
      } catch (error) { if (!canceled && request === generation.current) setError(error instanceof Error ? error.message : 'Cannot read repository.'); }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => { canceled = true; active.current = false; generation.current++; clearInterval(timer); };
  }, [model, agentId, engineId, visible]);
  const run = async (action: 'use-files' | 'apply') => {
    if (operation.current || disabled) return;
    operation.current = true; generation.current++; onBusy(true); setError(null);
    try {
      if (action === 'apply') {
        if (!engineId) throw new Error('Choose a Docker engine.');
        const result = await model.runtime({ action: 'start', agentId, engineId });
        if (result.details?.ready !== true) throw new Error(result.details?.error ?? result.lifecycle?.error ?? 'Worker is not ready.');
        await model.refresh();
      }
      const next = await model.source({ agentId, action: action === 'apply' ? 'status' : action, ...(engineId ? { engineId } : {}) });
      if (active.current) setSource(next);
    } catch (error) { if (active.current) setError(error instanceof Error ? error.message : 'Repository operation failed.'); }
    finally { operation.current = false; if (active.current) onBusy(false); }
  };
  const blockedSource = source && ['invalid', 'conflict', 'missing'].includes(source.phase);
  const applyButton = <NeumorphicButton variant="standard" disabled={disabled || !engineId || !source || Boolean(blockedSource)} onClick={() => { void run('apply'); }}>Apply changes</NeumorphicButton>;
  return <>
    {(blockedSource || error || actionsTarget === undefined) && <section className={layout.section} aria-label="Repository configuration">
      {blockedSource && <p className={styles.description} role="alert">{source?.message}</p>}
      {source?.phase === 'conflict' && <div className={layout.actions}>
        <NeumorphicButton variant="standard" disabled={disabled} onClick={() => { void run('use-files'); }}>Use repository files</NeumorphicButton>
      </div>}
      {actionsTarget === undefined && applyButton}
      {error && <p className={styles.description} role="alert">{error}</p>}
    </section>}
    {actionsTarget ? createPortal(applyButton, actionsTarget) : null}
  </>;
}
