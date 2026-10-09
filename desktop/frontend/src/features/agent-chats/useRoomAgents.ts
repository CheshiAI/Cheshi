import { useEffect, useMemo, useState } from 'react';
import type { AgentRegistryApi, AgentRegistrySnapshot } from '../../../../shared/agent-registry';
import type { ChatMember } from '../../../../shared/agent-chats';

export const DELETED_HOMIE = 'Deleted Homie';

export function useRoomAgents(registry: Pick<AgentRegistryApi, 'list' | 'onDidChange'> | undefined, active: boolean) {
  const [catalog, setCatalog] = useState<{ source: typeof registry; snapshot: AgentRegistrySnapshot | null; error: boolean }>({
    source: registry, snapshot: null, error: false,
  });
  useEffect(() => {
    if (!active) return;
    let stopped = false, version = 0;
    const update = async () => {
      const request = ++version;
      setCatalog({ source: registry, snapshot: null, error: false });
      try {
        if (!registry) throw new Error('Agent catalog is unavailable.');
        const snapshot = await registry.list();
        if (!stopped && request === version) setCatalog({ source: registry, snapshot, error: false });
      } catch {
        if (!stopped && request === version) setCatalog({ source: registry, snapshot: null, error: true });
      }
    };
    const unsubscribe = registry?.onDidChange(() => { void update(); });
    void update();
    return () => { stopped = true; unsubscribe?.(); };
  }, [registry, active]);
  const snapshot = catalog.source === registry ? catalog.snapshot : null;
  const agents = useMemo(() => snapshot?.agents.filter(agent => agent.accountId
    && agent.assignments.some(a => a.workspaceRoot === snapshot.workspaceRoot)) ?? [], [snapshot]);
  function status(member: ChatMember | undefined, workspace: string): string | null {
    if (catalog.source === registry && catalog.error) return 'Homie registration could not be checked. Tasks are unavailable.';
    if (!snapshot) return 'Checking Homie registration…';
    const agent = snapshot.agents.find(agent => agent.id === member?.id);
    if (!agent) return DELETED_HOMIE;
    if (agent.accountId !== member?.accountId || !agent.assignments.some(a => a.workspaceRoot === workspace)) return 'Homie unavailable · Check its project assignment and account';
    return null;
  }
  return { agents, status };
}
