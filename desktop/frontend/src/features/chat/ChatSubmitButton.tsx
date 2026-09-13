import { ArrowUp, Square } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui';
import styles from './ChatView.module.css';

interface ChatSubmitButtonProps {
  streaming: boolean;
  sendDisabled: boolean;
  goalEditorOpen: boolean;
  onStop: () => void;
}

export function ChatSubmitButton({ streaming, sendDisabled, goalEditorOpen, onStop }: ChatSubmitButtonProps) {
  const stopping = streaming && sendDisabled;
  const label = stopping ? 'Stop response' : goalEditorOpen ? 'Set persistent goal'
    : streaming ? 'Send additional instruction' : 'Send message';
  return (
    <NeumorphicButton raised
      className={`sidebar-heading-action ${stopping ? styles.stopButton : styles.sendButton}`}
      aria-label={label} title={label}
      disabled={!stopping && sendDisabled}
      type={stopping ? 'button' : 'submit'}
      onClick={stopping ? onStop : undefined}>
      {stopping ? <Square aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
    </NeumorphicButton>
  );
}
