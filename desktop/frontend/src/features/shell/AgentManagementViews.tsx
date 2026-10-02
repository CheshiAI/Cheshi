import { useEffect, useState, useSyncExternalStore } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { AgentManagementApi } from '../../../../shared/agent-management';
import { AgentManagementModel } from '../../shared/agent-management/agentManagementModel';
import styles from '../../shared/agent-management/agentManagement.module.css';
import { AgentsView } from '../agents/AgentsView';
import { DockerView } from '../docker/DockerView';

type ManagementView = 'docker' | 'agents' | null;

/** Remains mounted in the workspace shell so navigation preserves engine/worker selection. */
export function AgentManagementViews({ view, onOpenDocker, api = cheshiDesktop?.agentManagement }: {
  view: ManagementView; onOpenDocker(): void; api?: AgentManagementApi;
}) {
  const [model, setModel] = useState<AgentManagementModel | null>(null);
  useEffect(() => {
    if (!api) { setModel(null); return; }
    const next = new AgentManagementModel(api);
    setModel(next);
    return () => { next.dispose(); };
  }, [api]);
  if (!api) return view ? <main className={styles.unavailable}>Worker management is available in the desktop app.</main> : null;
  return model ? <ManagementScreens model={model} view={view} onOpenDocker={onOpenDocker} /> : null;
}

function ManagementScreens({ model, view, onOpenDocker }: {
  model: AgentManagementModel; view: ManagementView; onOpenDocker(): void;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot);
  useEffect(() => {
    if (!view) return;
    if (model.snapshot().engineId) void model.refresh();
    else void model.discover();
    const timer = setInterval(() => { void model.refresh({ background: true }); }, 10_000);
    return () => { clearInterval(timer); };
  }, [model, view]);
  if (view === 'docker') return <DockerView model={model} state={state} />;
  if (view === 'agents') return <AgentsView model={model} state={state} onOpenDocker={onOpenDocker} />;
  return null;
}
