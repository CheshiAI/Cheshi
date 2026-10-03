import { useState } from 'react';
import { LiquidGlassSelect, Modal, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import type { AgentRoom, ChatsRequest } from '../../../../shared/agent-chats';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import type { AgentEngineInfo } from '../../../../shared/agent-management';
import styles from './ChatsView.module.css';
export function RoomDialog({ room, agents, engines, onSave, onClose }: {
  room?: AgentRoom; agents: SpecialistAgent[]; engines: AgentEngineInfo[];
  onSave(request: ChatsRequest): Promise<void>; onClose(): void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(''), [engine, setEngine] = useState(engines.find(e => e.supported)?.id ?? '');
  const [members, setMembers] = useState(room?.members.map(m => m.id) ?? []);
  const [owner, setOwner] = useState(room?.defaultAgentId ?? '');
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const candidates = [...agents.map(a => ({ id: a.id, name: a.name })), ...(room?.members.filter(m => !agents.some(a => a.id === m.id)) ?? [])];
  async function save() {
    setSaving(true); setError(null);
    try {
      await onSave(room ? { action: 'invite', roomId: room.id, members, defaultAgentId: owner }
        : { action: 'create', id, name, engineId: engine, members, defaultAgentId: owner });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save this room.'); }
    finally { setSaving(false); }
  }
  return <Modal title={room ? 'Room participants' : 'New room'} headerVariant="section" closeButtonVariant="ghost" onClose={onClose} closeDisabled={saving}>
    <div className={styles.form}>
      {!room && <><label>Room name<NeumorphicTextField variant="standard" aria-label="Room name" value={name} maxLength={100} disabled={saving} onChange={e => setName(e.target.value)} /></label>
        <label>Execution engine<LiquidGlassSelect ariaLabel="Room execution engine" value={engine} options={engines.filter(e => e.supported).map(e => ({ value: e.id, label: e.name }))} onChange={setEngine} disabled={saving} /></label></>}
      <fieldset disabled={saving}><legend>Invite agents</legend>
        {candidates.map(a => <label className={styles.member} key={a.id}><input type="checkbox" checked={members.includes(a.id)} disabled={room?.members.some(m => m.id === a.id)} onChange={e => {
          const next = e.target.checked ? [...members, a.id] : members.filter(id => id !== a.id);
          setMembers(next); if (!next.includes(owner)) setOwner(next[0] ?? '');
        }} />{a.name}</label>)}
        {!candidates.length && <p className={styles.description}>Register an agent, assign it to this project, and select an account in Agents.</p>}
      </fieldset>
      <label>Default agent<LiquidGlassSelect ariaLabel="Default agent" value={owner} options={candidates.filter(a => members.includes(a.id)).map(a => ({ value: a.id, label: a.name }))} onChange={setOwner} disabled={saving || !members.length} /></label>
      <p className={styles.description}>Only invited agents can collaborate in this room. Start their workers in Agents before sending work. Existing participants retain their room identity.</p>
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}><NeumorphicButton variant="standard" disabled={saving || !members.length || !owner || (!room && (!name.trim() || !engine))} onClick={() => void save()}>{saving ? 'Saving…' : room ? 'Save participants' : 'Create room'}</NeumorphicButton></div>
    </div>
  </Modal>;
}
