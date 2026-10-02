import { useState } from 'react';
import { Shuffle } from 'lucide-react';
import { AGENT_AVATAR_CHARACTERS, AGENT_AVATAR_COLORS, AGENT_AVATAR_COLOR_NAMES, randomAgentAvatar } from '../../../../shared/agent-avatar';
import type { AgentAvatarValue } from '../../../../shared/agent-avatar';
import { Modal, NeumorphicButton } from '../../shared/ui';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import styles from './AgentAvatarPicker.module.css';

export function AgentAvatarPicker({ value, disabled, onChange }: {
  value: AgentAvatarValue; disabled: boolean; onChange(value: AgentAvatarValue): void;
}) {
  const [draft, setDraft] = useState<AgentAvatarValue | null>(null);
  return <div className={styles.field}>
    <span>Icon</span>
    <NeumorphicButton variant="ghost" className={styles.trigger} aria-label="Choose agent icon" disabled={disabled} onClick={() => setDraft(value)}>
      <AgentAvatar avatar={value} preview /><span>Choose icon</span>
    </NeumorphicButton>
    {draft && <Modal title="AGENT ICON" headerVariant="section" closeButtonVariant="ghost" className={styles.dialog}
      onClose={() => setDraft(null)}>
      <div className={styles.content}>
        <div className={styles.preview}><AgentAvatar avatar={draft} preview /><span>{draft.character} · {draft.color}</span>
          <NeumorphicButton variant="ghost" aria-label="Randomize agent icon" disabled={disabled}
            onClick={() => setDraft(randomAgentAvatar(draft))}><Shuffle aria-hidden="true" />Random</NeumorphicButton></div>
        <div className={styles.characters} role="group" aria-label="Icon characters">
          {AGENT_AVATAR_CHARACTERS.map(character => <NeumorphicButton key={character} variant="ghost" className={styles.choice}
            aria-label={`Character ${character}`} title={character} aria-pressed={draft.character === character} disabled={disabled}
            onClick={() => setDraft({ ...draft, character })}><AgentAvatar avatar={{ ...draft, character }} preview /></NeumorphicButton>)}
        </div>
        <div className={styles.colors} role="group" aria-label="Icon colors">
          {AGENT_AVATAR_COLOR_NAMES.map(color => <NeumorphicButton key={color} variant="ghost" className={styles.color}
            aria-label={`Color ${color}`} title={color} aria-pressed={draft.color === color} disabled={disabled}
            onClick={() => setDraft({ ...draft, color })}><span style={{ backgroundColor: AGENT_AVATAR_COLORS[color] }} /></NeumorphicButton>)}
        </div>
        <div className={styles.actions}>
          <NeumorphicButton variant="ghost" onClick={() => setDraft(null)}>Cancel</NeumorphicButton>
          <NeumorphicButton variant="standard" disabled={disabled} onClick={() => { onChange(draft); setDraft(null); }}>Use icon</NeumorphicButton>
        </div>
      </div>
    </Modal>}
  </div>;
}
