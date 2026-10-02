import { useRef, type ReactNode } from 'react';
import { RegionalBlur, SidebarPanelHeader } from '../ui';
import { useAutoHideScrollbars } from '../useAutoHideScrollbars';
import type { AgentManagementModel, AgentManagementState } from './agentManagementModel';
import styles from './agentManagement.module.css';

export interface AgentScreenProps { model: AgentManagementModel; state: AgentManagementState }

export function AgentManagementFrame({ title, icon, actions, bodyLayout = 'scroll', children }: {
  title: string; icon: ReactNode; actions?: ReactNode; bodyLayout?: 'scroll' | 'fill'; children: ReactNode;
}) {
  const sourceRef = useRef<HTMLElement>(null);
  const scrollbar = useAutoHideScrollbars<HTMLDivElement>();
  return <RegionalBlur sourceRef={sourceRef}>
    <main ref={sourceRef} className={styles.workspace} aria-label={title}>
      <SidebarPanelHeader title={title.toUpperCase()} icon={icon} actions={actions} />
      <div ref={scrollbar} className={bodyLayout === 'fill' ? styles.fill : styles.scroll}>{children}</div>
    </main>
  </RegionalBlur>;
}

export function AgentManagementNotice({ state }: { state: AgentManagementState }) {
  const error = state.error ?? state.snapshot?.error ?? state.catalog.error;
  return <>
    {error && <p role="alert" className={styles.description}>{error}</p>}
    {state.snapshot?.online && state.snapshot.agents.length === 0
      && <p className={styles.description}>No managed workers found on this engine.</p>}
  </>;
}
