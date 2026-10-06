import { useEffect, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { AgentChatsApi, AgentRoom } from '../../../../shared/agent-chats';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import { LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import styles from './SpecialistAgentForm.module.css';

function assertJoinableRoom(room: AgentRoom | undefined, agent: SpecialistAgent): asserts room is AgentRoom {
  if (!room) throw new Error('This room was removed. Choose another room.');
  const member = room.members.find(item => item.id === agent.id);
  if (member && member.accountId !== agent.accountId) throw new Error('This room retains an earlier account identity. Create a new room for this Homie.');
}
export function HomieParticipation({ agent, workspaceRoot, roomId, api = cheshiDesktop?.agentChats }: {
  agent: SpecialistAgent; workspaceRoot: string; roomId?: string; api?: AgentChatsApi;
}) {
  const [rooms, setRooms] = useState<AgentRoom[]>([]);
  const [selected, setSelected] = useState(roomId ?? '');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true), pending = useRef(false);
  useEffect(() => {
    active.current = true;
    if (!api) { setLoading(false); return; }
    void api.request({ action: 'list' }).then(snapshot => { if (active.current) setRooms(snapshot.rooms); }, reason => {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Could not load rooms.');
    }).finally(() => { if (active.current) setLoading(false); });
    return () => { active.current = false; };
  }, [api]);
  const room = rooms.find(item => item.id === selected);
  const member = room?.members.find(item => item.id === agent.id);
  const assigned = agent.assignments.some(item => item.workspaceRoot === workspaceRoot);
  async function join() {
    if (!api || !room || pending.current || !assigned || !agent.accountId) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      // Re-read immediately before adding so newer participants and the default are preserved.
      const snapshot = await api.request({ action: 'list' });
      if (!active.current) return;
      const current = snapshot.rooms.find(item => item.id === selected);
      assertJoinableRoom(current, agent);
      const existing = current.members.find(item => item.id === agent.id);
      const result = existing ? snapshot : await api.request({ action: 'invite', roomId: current.id,
        members: [...current.members.map(item => item.id), agent.id], defaultAgentId: current.defaultAgentId });
      if (active.current) setRooms(result.rooms);
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : 'Could not join room.'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <section className={styles.field} aria-label="Homie participation">
    <h3>Work participation</h3>
    <LiquidGlassSelect ariaLabel="Homie work room" menuAppearance="toolbar" triggerAppearance="standard" value={selected}
      disabled={busy || loading} options={[{ value: '', label: loading ? 'Loading rooms…' : 'Choose a work room' }, ...rooms.map(item => ({ value: item.id, label: item.name }))]}
      onChange={value => { setSelected(value); setError(null); }} />
    <NeumorphicButton variant="ghost" disabled={!api || busy || !room || !assigned || !agent.accountId || Boolean(member)} onClick={() => { void join(); }}>
      {busy ? 'Joining…' : member ? 'Participating' : 'Join work room'}
    </NeumorphicButton>
    {member && member.accountId !== agent.accountId && <p role="status" className={styles.description}>This room retains an earlier account identity.</p>}
    {!assigned || !agent.accountId ? <p className={styles.description}>Save a project assignment and account before joining a room.</p>
      : <p className={styles.description}>Joining makes this Homie available for mentions and collaboration. It does not send a task.</p>}
    {!loading && !rooms.length && <p className={styles.description}>Create a work room from the Worker sidebar first.</p>}
    {error && <p role="alert" className={styles.description}>{error}</p>}
  </section>;
}
