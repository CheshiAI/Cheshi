import { Check, ClipboardClock, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NeumorphicButton, Tooltip } from '../../shared/ui';
import type { ChatSavedTurnInput } from '../../../../shared/chat-saved-turns';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import styles from './ChatTurnActions.module.css';
import { AppleNotesSaveAction } from '../notes/AppleNotesSaveAction';

export function ChatTurnActions({ turn, savedTurns }: { turn: ChatSavedTurnInput; savedTurns: SavedChatTurnsController }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (resetTimer.current) clearTimeout(resetTimer.current); };
  }, []);
  const saved = savedTurns.isSaved(turn.threadId, turn.itemId);
  const saving = savedTurns.isSaving(turn.threadId, turn.itemId);
  const copy = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(turn.assistantText);
      if (!mounted.current) return;
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (mounted.current) setCopyError('Could not copy this response. Please try again.');
    }
  };
  const save = async () => {
    setSaveError(false);
    const accepted = await savedTurns.save(turn);
    if (mounted.current) setSaveError(!accepted);
  };
  const saveLabel = saved ? 'Turn saved' : saving ? 'Saving turn…' : 'Save turn';
  return (
    <div className={styles.root}>
      <div className={styles.actions} role="group" aria-label="Response actions">
        <Tooltip content={copied ? 'Copied' : 'Copy response'}>{(props) => (
          <NeumorphicButton {...props} type="button" className={styles.button} aria-label={copied ? 'Copied' : 'Copy response'} onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </NeumorphicButton>
        )}</Tooltip>
        <Tooltip content={saveLabel}>{(props) => (
          <NeumorphicButton {...props} type="button" className={styles.button} aria-label={saveLabel}
            aria-pressed={saved} disabled={saving || saved} onClick={() => void save()}>
            <ClipboardClock aria-hidden="true" />
          </NeumorphicButton>
        )}</Tooltip>
        <AppleNotesSaveAction key={`${turn.threadId}:${turn.itemId}`} title={turn.sessionTitle} body={turn.assistantText} />
        <span className={styles.feedback} role="status">{copied ? 'Copied' : saved ? 'Saved' : saving ? 'Saving…' : ''}</span>
      </div>
      {(copyError || saveError) && <p className={styles.error} role="alert">{copyError || 'Could not save this turn. Please try again.'}</p>}
    </div>
  );
}
