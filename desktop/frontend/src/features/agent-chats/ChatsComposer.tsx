import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import { X } from 'lucide-react';
import type { ChatMember, RoomMessage } from '../../../../shared/agent-chats';
import { NeumorphicButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ChatComposerInput, ChatComposerSurface } from '../chat/ChatComposerSurface';
import { ChatSubmitButton } from '../chat/ChatSubmitButton';
import composer from '../chat/ChatComposer.module.css';
import styles from './ChatsView.module.css';

export function ChatsComposer({ areaRef, active, draft, sending, resumeGoal, sendDisabled, onSend, onDraftChange,
  deliveryTarget, replyMessage, replyName, onCancelReply, mentionChoices, onMention, children }: {
  areaRef: Ref<HTMLElement>; active: boolean; draft: string; sending: boolean; resumeGoal: boolean; sendDisabled: boolean;
  onSend(): void; onDraftChange(text: string): void; deliveryTarget: string;
  replyMessage?: RoomMessage; replyName: string; onCancelReply(): void;
  mentionChoices: ChatMember[]; onMention(member: ChatMember): void; children?: ReactNode;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !active) return;
    const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth; resize();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [active, draft]);
  const submit = () => { if (!sendDisabled && !composing.current) onSend(); };
  return <footer ref={areaRef} className={`${composer.composerArea} ${styles.composerArea}`}>
    <ChatComposerSurface aria-label="Room composer" aria-busy={sending}
      onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className={styles.composerContext}>
        {children}
        {replyMessage && <div className={styles.replyContext} aria-label="Reply context">
          <span>Replying to {replyName}: {replyMessage.text.slice(0, 160)}</span>
          <TooltipButton variant="ghost" size="icon" title="Cancel reply" aria-label="Cancel reply" onClick={onCancelReply}><X aria-hidden="true" /></TooltipButton>
        </div>}
        {mentionChoices.length > 0 && <div className={styles.links} aria-label="Mention suggestions">
          {mentionChoices.map(member => <NeumorphicButton key={member.id} type="button" variant="standard"
            onClick={() => { onMention(member); inputRef.current?.focus(); }}>@{member.name}</NeumorphicButton>)}
        </div>}
      </div>
      <ChatComposerInput ref={inputRef} aria-label="Message" value={draft} maxLength={16000}
        placeholder={resumeGoal ? 'Add the missing information to resume this goal…' : 'Message the room, or @mention an agent…'}
        onChange={event => onDraftChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
            || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault(); submit();
        }} />
      <div className={composer.composerFooter}>
        <p className={`${styles.description} ${styles.deliveryTarget}`} aria-label="Delivery target" role="status">
          {sending ? 'Saving…' : deliveryTarget}
          {resumeGoal && !sending && <span> · Send to resume this goal</span>}
        </p>
        <div className={composer.composerActions}>
          <ChatSubmitButton streaming={false} goalEditorOpen={false} sendDisabled={sendDisabled} onStop={() => {}} />
        </div>
      </div>
    </ChatComposerSurface>
  </footer>;
}
