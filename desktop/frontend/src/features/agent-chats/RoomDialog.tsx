import { useState } from 'react';
import { LiquidGlassSelect, Modal, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import type { ChatsRequest } from '../../../../shared/agent-chats';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import type { AgentEngineInfo } from '../../../../shared/agent-management';
import styles from './ChatsView.module.css';
export function RoomDialog({ agents, engines, onSave, onClose }: {
  agents: SpecialistAgent[]; engines: AgentEngineInfo[];
  onSave(request: ChatsRequest): Promise<void>; onClose(): void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(''), [engine, setEngine] = useState(engines.find(e => e.supported)?.id ?? '');
  const [members, setMembers] = useState<string[]>([]);
  const [owner, setOwner] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const candidates = agents.map(a => ({ id: a.id, name: a.name, available: !!a.accountId }));
  const defaults = candidates.filter(a => a.available && members.includes(a.id));
  const ownerAvailable = defaults.some(a => a.id === owner);
  async function save() {
    if (!ownerAvailable) return;
    setSaving(true); setError(null);
    try {
      await onSave({ action: 'create', id, name, engineId: engine, members, defaultAgentId: owner });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save this room.'); }
    finally { setSaving(false); }
  }
  return <Modal title="New room" headerVariant="section" closeButtonVariant="ghost" onClose={onClose} closeDisabled={saving}>
    <div className={styles.form}>
      <><label>Room name<NeumorphicTextField variant="standard" aria-label="Room name" value={name} maxLength={100} disabled={saving} onChange={e => setName(e.target.value)} /></label>
        <label>Execution engine<LiquidGlassSelect ariaLabel="Room execution engine" value={engine} options={engines.filter(e => e.supported).map(e => ({ value: e.id, label: e.name }))} onChange={setEngine} disabled={saving} /></label></>
      <fieldset disabled={saving}><legend>Invite agents</legend>
        {candidates.map(a => <label className={styles.member} key={a.id}><input type="checkbox" checked={members.includes(a.id)} disabled={!a.available} onChange={e => {
          const next = e.target.checked ? [...members, a.id] : members.filter(id => id !== a.id);
          setMembers(next); if (!next.includes(owner) || !ownerAvailable) setOwner(candidates.find(a => a.available && next.includes(a.id))?.id ?? '');
        }} />{a.name}{!a.available && <span className={styles.description}> · Unavailable</span>}</label>)}
        {!candidates.length && <p className={styles.description}>Create a Homie, assign it to this project, and select an account in Homies.</p>}
      </fieldset>
      <label>Default agent<LiquidGlassSelect ariaLabel="Default agent" value={ownerAvailable ? owner : ''} placeholder="Choose an available agent" options={defaults.map(a => ({ value: a.id, label: a.name }))} onChange={setOwner} disabled={saving || !defaults.length} /></label>
      <p className={styles.description}>Only invited agents can collaborate in this room. Workers wake when work arrives. Manually stopped containers must be started from Homies → Runtime.</p>
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}><NeumorphicButton variant="standard" disabled={saving || !ownerAvailable || (!name.trim() || !engine)} onClick={() => void save()}>{saving ? 'Saving…' : 'Create room'}</NeumorphicButton></div>
    </div>
  </Modal>;
}
