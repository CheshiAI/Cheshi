import { X } from 'lucide-react';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import type { ChatTaskTarget } from '../../../../shared/agent-chats';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { AgentManagementApi } from '../../../../shared/agent-management';
import { AgentManagementModel } from '../../shared/agent-management/agentManagementModel';
import styles from '../../shared/agent-management/agentManagement.module.css';
import { AgentsView } from '../agents/AgentsView';
import { DockerView } from '../docker/DockerView';
import { AgentRegistryModel } from '../agents/agentRegistryModel';
import type { AgentRegistryApi } from '../../../../shared/agent-registry';
import type { CodexAccountsApi } from '../../../../shared/codex-accounts';

type ManagementView = 'docker' | 'homies' | null;
const emptyRegistrySnapshot = () => null;
const emptyRegistrySubscribe = () => () => {};

/** Remains mounted in the workspace shell so navigation preserves engine/worker selection. */
export function AgentManagementViews({ view, active = true, chatTask, onBackToChats, selectionRequest, onClose, api = cheshiDesktop?.agentManagement, registryApi = cheshiDesktop?.agentRegistry,
  accountsApi = cheshiDesktop?.codexAccounts }: {
  chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  selectionRequest?: { agentId: string | null }; onClose?(): void;
  active?: boolean; view: ManagementView; api?: AgentManagementApi; registryApi?: AgentRegistryApi;
  accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const [model, setModel] = useState<AgentManagementModel | null>(null);
  const [registry, setRegistry] = useState<AgentRegistryModel | null>(null);
  useEffect(() => {
    if (!registryApi) { setRegistry(null); return; }
    const next = new AgentRegistryModel(registryApi);
    setRegistry(next);
    return () => { next.dispose(); };
  }, [registryApi]);
  useEffect(() => {
    if (!api) { setModel(null); return; }
    const next = new AgentManagementModel(api);
    setModel(next);
    return () => { next.dispose(); };
  }, [api]);
  if (!api) return view ? <main className={styles.unavailable}><p>Worker management is available in the desktop app.</p>{onClose && <TooltipButton variant="ghost" size="icon" aria-label="Close Homies" title="Close Homies" onClick={onClose}><X aria-hidden="true" /></TooltipButton>}</main> : null;
  return model ? <ManagementScreens active={active} selectionRequest={selectionRequest} onClose={onClose} onStopWorker={async (engineId, workerId) => { await api.control(engineId, workerId, 'stop'); await model.refresh(); }} chatTask={chatTask} onBackToChats={onBackToChats} model={model} view={view} registry={registry} accountsApi={accountsApi} /> : null;
}

function ManagementScreens({ active, selectionRequest, onClose, onStopWorker, chatTask, onBackToChats, model, view, registry, accountsApi }: {
  chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  selectionRequest?: { agentId: string | null }; onClose?(): void;
  onStopWorker(engineId: string, workerId: string): Promise<void>;
  active: boolean; model: AgentManagementModel; view: ManagementView; registry: AgentRegistryModel | null;
  accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot);
  const registered = useSyncExternalStore(registry?.subscribe ?? emptyRegistrySubscribe, registry?.snapshot ?? emptyRegistrySnapshot);
  useEffect(() => { if (view && active) void registry?.refresh(); }, [registry, view, active]);
  useEffect(() => {
    if (!view || !active) return;
    if (model.snapshot().engineId) void model.refresh();
    else void model.discover();
    const timer = setInterval(() => { void model.refresh({ background: true }); }, 10_000);
    return () => { clearInterval(timer); };
  }, [model, view, active]);
  if (view === 'docker') return <DockerView model={model} state={state} profiles={registered?.data?.agents}
    onRefreshProfiles={() => { void registry?.refresh(); }} />;
  if (view === 'homies') return <AgentsView active={active} selectionRequest={selectionRequest} onClose={onClose} onStopWorker={onStopWorker} chatTask={chatTask} onBackToChats={onBackToChats} model={model} state={state} registry={registry} accountsApi={accountsApi} />;
  return null;
}
