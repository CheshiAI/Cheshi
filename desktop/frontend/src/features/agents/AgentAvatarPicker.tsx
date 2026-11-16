import { useEffect, useRef, useState } from 'react';
import { Shuffle, Upload } from 'lucide-react';
import { AGENT_AVATAR_CHARACTERS, AGENT_AVATAR_COLORS, AGENT_AVATAR_COLOR_NAMES, randomAgentAvatar } from '../../../../shared/agent-avatar';
import type { AgentAvatarValue } from '../../../../shared/agent-avatar';
import { AVATAR_IMAGE_ACCEPT, readAvatarImage } from '../../../../shared/agent-avatar-image';
import { Modal, NeumorphicButton } from '../../shared/ui';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import styles from './AgentAvatarPicker.module.css';

async function checkImageDecoding(source: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth <= 4096 && image.naturalHeight <= 4096) resolve();
      else reject(new Error('Icon images must be between 1 and 4096 pixels on each side.'));
    };
    image.onerror = () => reject(new Error('Could not decode this icon image.'));
    image.src = source;
  });
}

export function AgentAvatarPicker({ value, disabled, onChange }: {
  value: AgentAvatarValue; disabled: boolean; onChange(value: AgentAvatarValue): void;
}) {
  const [draft, setDraft] = useState<AgentAvatarValue | null>(null);
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const generation = useRef(0), fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { generation.current++; }, []);
  const close = () => { generation.current++; setDraft(null); setError(null); setLoading(false); };
  const upload = async (file: File) => {
    if (disabled || !draft) return;
    const version = ++generation.current;
    setLoading(true); setError(null);
    try {
      const image = await readAvatarImage(file);
      if (generation.current !== version) return;
      await checkImageDecoding(image);
      if (generation.current === version) setDraft({ ...draft, image });
    } catch (reason) {
      if (generation.current === version) setError(reason instanceof Error ? reason.message : 'Could not load this icon.');
    } finally { if (generation.current === version) setLoading(false); }
  };
  const blocked = disabled || loading;
  return <div className={styles.field}>
    <NeumorphicButton variant="ghost" className={styles.trigger} aria-label="Choose agent icon" title="Choose icon" disabled={disabled}
      onClick={() => { setError(null); setDraft(value); }}>
      <AgentAvatar avatar={value} preview />
    </NeumorphicButton>
    {draft && <Modal title="AGENT ICON" headerVariant="section" closeButtonVariant="ghost" className={styles.dialog} onClose={close}>
      <div className={styles.content}>
        <div className={styles.preview}><AgentAvatar avatar={draft} preview /><span>{draft.image ? 'Custom image' : `${draft.character} · ${draft.color}`}</span>
          <NeumorphicButton variant="ghost" aria-label="Randomize agent icon" disabled={blocked}
            onClick={() => setDraft(randomAgentAvatar(draft))}><Shuffle aria-hidden="true" />Random</NeumorphicButton></div>
        <input ref={fileInput} type="file" hidden accept={AVATAR_IMAGE_ACCEPT} aria-label="Agent icon image" disabled={blocked}
          onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file); }} />
        <NeumorphicButton variant="ghost" disabled={blocked} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" />Upload image</NeumorphicButton>
        <p className={styles.hint}>PNG, JPG, GIF or WebP · up to 2 MiB · 4096 × 4096 pixels</p>
        {error && <p className={styles.hint} role="alert">{error}</p>}
        <div className={styles.characters} role="group" aria-label="Icon characters">
          {AGENT_AVATAR_CHARACTERS.map(character => <NeumorphicButton key={character} variant="ghost" className={styles.choice}
            aria-label={`Character ${character}`} title={character} aria-pressed={!draft.image && draft.character === character} disabled={blocked}
            onClick={() => setDraft({ character, color: draft.color })}><AgentAvatar avatar={{ character, color: draft.color }} preview /></NeumorphicButton>)}
        </div>
        <div className={styles.colors} role="group" aria-label="Icon colors">
          {AGENT_AVATAR_COLOR_NAMES.map(color => <NeumorphicButton key={color} variant="ghost" className={styles.color}
            aria-label={`Color ${color}`} title={color} aria-pressed={!draft.image && draft.color === color} disabled={blocked}
            onClick={() => setDraft({ character: draft.character, color })}><span style={{ backgroundColor: AGENT_AVATAR_COLORS[color] }} /></NeumorphicButton>)}
        </div>
        <div className={styles.actions}>
          <NeumorphicButton variant="ghost" onClick={close}>Cancel</NeumorphicButton>
          <NeumorphicButton variant="standard" disabled={blocked} onClick={() => { onChange(draft); close(); }}>Save</NeumorphicButton>
        </div>
      </div>
    </Modal>}
  </div>;
}
