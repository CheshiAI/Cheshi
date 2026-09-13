import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/errorMessage';
import type { ChatController } from './useChatController';
import type { ChatPermissionMode } from './model';
import { useChatTaskScope } from './useChatTaskScope';

export type ChatPermissionController = Pick<ChatController, 'state' | 'sessionRevision' | 'listPermissionModes' | 'setPermissionMode'>;

export function chatPermissionChoices(modes: readonly ChatPermissionMode[], selected: ChatPermissionMode | null) {
  return selected && !modes.some((mode) => mode.id === selected.id) ? [selected, ...modes] : modes;
}

export function useChatPermissions(controller: ChatPermissionController, disabled: boolean) {
  const { state, sessionRevision, listPermissionModes, setPermissionMode } = controller;
  const captureTask = useChatTaskScope(`${sessionRevision}:${state.activeSessionId ?? ''}`);
  const [modes, setModes] = useState<ChatPermissionMode[]>([]);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingChange = useRef(false);
  const selected = state.permissionMode;
  const refresh = useCallback(async () => {
    const isCurrent = captureTask();
    setLoading(true);
    setError(null);
    try {
      const response = await listPermissionModes();
      if (isCurrent()) setModes(response.modes);
    } catch (failure) {
      if (isCurrent()) setError(errorMessage(failure));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [captureTask, listPermissionModes]);

  useEffect(() => {
    setModes([]);
    setChanging(false);
    pendingChange.current = false;
    void refresh();
  }, [sessionRevision, state.activeSessionId, refresh]);

  const choose = async (id: string) => {
    if (disabled || loading || pendingChange.current || id === selected?.id) return;
    const mode = modes.find((candidate) => candidate.id === id);
    if (!mode || !mode.allowed) return;
    const isCurrent = captureTask();
    pendingChange.current = true;
    setChanging(true);
    setError(null);
    try { await setPermissionMode(id); }
    catch (failure) { if (isCurrent()) setError(errorMessage(failure)); }
    finally {
      if (isCurrent()) { pendingChange.current = false; setChanging(false); }
    }
  };

  return { choices: chatPermissionChoices(modes, selected), selected, loading, changing, error, refresh, choose };
}
