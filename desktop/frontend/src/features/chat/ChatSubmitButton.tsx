import { ArrowUp, Square } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui';
import styles from './ChatComposer.module.css';

interface ChatSubmitButtonProps {
  streaming: boolean;
  sendDisabled: boolean;
  goalEditorOpen: boolean;
  onStop: () => void;
}

export function ChatSubmitButton({ streaming, sendDisabled, goalEditorOpen, onStop }: ChatSubmitButtonProps) {
  const stopping = streaming && sendDisabled;
  const label = stopping ? 'Stop response' : goalEditorOpen ? 'Set persistent goal'
    : streaming ? 'Queue message' : 'Send message';
  return (
    <NeumorphicButton variant="standard" size="icon"
      className={stopping ? styles.stopButton : styles.sendButton}
      aria-label={label} title={label}
      disabled={!stopping && sendDisabled}
      type={stopping ? 'button' : 'submit'}
      onClick={stopping ? onStop : undefined}>
      {stopping ? <Square aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
    </NeumorphicButton>
  );
}
