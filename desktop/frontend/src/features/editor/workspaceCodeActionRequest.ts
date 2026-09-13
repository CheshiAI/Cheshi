import type { Dispatch, SetStateAction } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import type { LanguageServerCodeAction } from '../../cheshiDesktop';
import type { WorkspaceCodeActionsState, WorkspaceEditorAssistState } from './workspaceEditorAssistState';

interface WorkspaceCodeActionRequest {
  load: () => Promise<LanguageServerCodeAction[]>;
  isCurrent: () => boolean;
  setAssistState: Dispatch<SetStateAction<WorkspaceEditorAssistState | null>>;
}

export async function requestWorkspaceCodeActions({ load, isCurrent, setAssistState }: WorkspaceCodeActionRequest): Promise<void> {
  const pending: WorkspaceCodeActionsState = { kind: 'actions', actions: [], loading: true, error: null };
  setAssistState(pending);

  const finish = (next: WorkspaceCodeActionsState): void => {
    const applicable = isCurrent();
    // Only the panel opened by this request may receive its result.
    setAssistState((current) => current === pending ? (applicable ? next : null) : current);
  };

  try {
    const actions = await load();
    finish({
      kind: 'actions',
      loading: false,
      error: null,
      actions: [...actions].sort((left, right) => (
        Number(Boolean(left.disabledReason) || !left.edit)
        - Number(Boolean(right.disabledReason) || !right.edit)
        || Number(right.preferred) - Number(left.preferred)
        || left.title.localeCompare(right.title)
      )),
    });
  } catch (error) {
    finish({ kind: 'actions', actions: [], loading: false, error: errorMessage(error) });
  }
}
