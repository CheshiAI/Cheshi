import { BookOpen } from 'lucide-react';

import { DismissibleToast, LoadingState } from '../../shared/ui';
import type { CodeExplanationState } from './workspaceCodeExplanation';
import styles from './WorkspaceCodeExplanationToast.module.css';

interface WorkspaceCodeExplanationToastProps {
  state: CodeExplanationState | null;
  selectionError: string | null;
  onDismiss: () => void;
}

export function WorkspaceCodeExplanationToast({ state, selectionError, onDismiss }: WorkspaceCodeExplanationToastProps) {
  if (!state && !selectionError) return null;
  const selection = state?.selection;
  const error = selectionError ?? state?.error;
  return (
    <DismissibleToast
      className={styles.card}
      title="Code explanation"
      icon={<BookOpen aria-hidden="true" />}
      description={selection ? `${selection.path} · ${selection.startLine}–${selection.endLine}` : undefined}
      onDismiss={onDismiss}
      dismissLabel="Close code explanation"
    >
      {error
        ? <p className={styles.message} role="alert">{error}</p>
        : state?.loading
          ? <LoadingState key={state.requestId} type="processing" />
          : <div className={styles.message} role="status">{state?.text}</div>}
    </DismissibleToast>
  );
}
