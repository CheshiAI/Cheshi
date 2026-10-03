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

type ManagementView = 'docker' | 'agents' | null;
const emptyRegistrySnapshot = () => null;
const emptyRegistrySubscribe = () => () => {};

/** Remains mounted in the workspace shell so navigation preserves engine/worker selection. */
export function AgentManagementViews({ view, chatTask, onBackToChats, api = cheshiDesktop?.agentManagement, registryApi = cheshiDesktop?.agentRegistry,
  accountsApi = cheshiDesktop?.codexAccounts }: {
  chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  view: ManagementView; api?: AgentManagementApi; registryApi?: AgentRegistryApi;
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
  if (!api) return view ? <main className={styles.unavailable}>Worker management is available in the desktop app.</main> : null;
  return model ? <ManagementScreens chatTask={chatTask} onBackToChats={onBackToChats} model={model} view={view} registry={registry} accountsApi={accountsApi} /> : null;
}

function ManagementScreens({ chatTask, onBackToChats, model, view, registry, accountsApi }: {
  chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  model: AgentManagementModel; view: ManagementView; registry: AgentRegistryModel | null;
  accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot);
  const registered = useSyncExternalStore(registry?.subscribe ?? emptyRegistrySubscribe, registry?.snapshot ?? emptyRegistrySnapshot);
  useEffect(() => { if (view) void registry?.refresh(); }, [registry, view]);
  useEffect(() => {
    if (!view) return;
    if (model.snapshot().engineId) void model.refresh();
    else void model.discover();
    const timer = setInterval(() => { void model.refresh({ background: true }); }, 10_000);
    return () => { clearInterval(timer); };
  }, [model, view]);
  if (view === 'docker') return <DockerView model={model} state={state} profiles={registered?.data?.agents}
    onRefreshProfiles={() => { void registry?.refresh(); }} />;
  if (view === 'agents') return <AgentsView chatTask={chatTask} onBackToChats={onBackToChats} model={model} state={state} registry={registry} accountsApi={accountsApi} />;
  return null;
}
