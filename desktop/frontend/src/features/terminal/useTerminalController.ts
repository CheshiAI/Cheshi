import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cheshiDesktop,
  type TerminalRuntimeState,
  type TerminalSplitDirection,
} from '../../cheshiDesktop';
import { EMPTY_TERMINAL_STATE, normalizeTerminalState } from './model';

interface TerminalSurfaceView {
  host: HTMLElement;
  resizeObserver: ResizeObserver;
}

export interface TerminalController {
  state: TerminalRuntimeState;
  error: string;
  registerHost: (paneId: string, host: HTMLElement | null) => void;
  newSession: () => void;
  selectSession: (sessionId: string) => void;
  closeSession: (sessionId: string) => void;
  closeAllSessions: () => void;
  selectPane: (sessionId: string, paneId: string) => void;
  splitPane: (
    sessionId: string,
    paneId: string,
    direction: TerminalSplitDirection,
  ) => Promise<boolean>;
  resizeSplit: (sessionId: string, splitId: string, ratio: number) => void;
  closePane: (sessionId: string, paneId: string) => void;
}

export function useTerminalController(active: boolean, previewActive = false): TerminalController {
  const desktopApi = cheshiDesktop;
  const [state, setState] = useState<TerminalRuntimeState>(EMPTY_TERMINAL_STATE);
  const [clientError, setClientError] = useState('');
  const views = useRef(new Map<string, TerminalSurfaceView>());
  const activeRef = useRef(active);
  activeRef.current = active;
  const previewRef = useRef(previewActive);
  previewRef.current = previewActive;

  const applyState = useCallback((value: unknown): void => {
    const next = normalizeTerminalState(value);
    if (!next) {
      setClientError('Cheshi received an invalid terminal state.');
      return;
    }
    setState(next);
    setClientError('');
    window.requestAnimationFrame(() => {
      if (previewRef.current) return;
      for (const [paneId, view] of views.current) {
        const bounds = view.host.getBoundingClientRect();
        desktopApi?.updateTerminalSurfaceBounds({
          paneId,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          visible: activeRef.current && view.host.offsetParent !== null,
        });
      }
    });
  }, [desktopApi]);

  const runAction = useCallback((action: () => Promise<unknown>): void => {
    void action().then(applyState).catch((error: unknown) => {
      setClientError(error instanceof Error ? error.message : String(error));
    });
  }, [applyState]);

  const syncPane = useCallback((paneId: string): void => {
    const view = views.current.get(paneId);
    if (!view || !desktopApi || previewRef.current) return;
    const bounds = view.host.getBoundingClientRect();
    desktopApi.updateTerminalSurfaceBounds({
      paneId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      visible: activeRef.current && view.host.offsetParent !== null,
    });
  }, [desktopApi]);

  const disposeView = useCallback((paneId: string): void => {
    const view = views.current.get(paneId);
    if (!view) return;
    view.resizeObserver.disconnect();
    const bounds = view.host.getBoundingClientRect();
    desktopApi?.updateTerminalSurfaceBounds({
      paneId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      visible: false,
    });
    views.current.delete(paneId);
  }, [desktopApi]);

  const registerHost = useCallback((paneId: string, host: HTMLElement | null): void => {
    const existing = views.current.get(paneId);
    if (!host) {
      disposeView(paneId);
      return;
    }
    if (existing?.host === host) return;
    disposeView(paneId);
    const resizeObserver = new ResizeObserver(() => syncPane(paneId));
    resizeObserver.observe(host);
    views.current.set(paneId, { host, resizeObserver });
    syncPane(paneId);
  }, [disposeView, syncPane]);

  useEffect(() => {
    if (!desktopApi) {
      setClientError('Terminal requires the Cheshi Electron app.');
      return undefined;
    }
    return desktopApi.onTerminalStateChanged(applyState);
  }, [applyState, desktopApi]);

  useEffect(() => {
    if (!desktopApi) return;
    runAction(() => desktopApi.setTerminalViewVisible(active && !previewActive));
  }, [active, previewActive, desktopApi, runAction]);

  useEffect(() => () => {
    for (const paneId of [...views.current.keys()]) disposeView(paneId);
    void desktopApi?.setTerminalViewVisible(false);
  }, [desktopApi, disposeView]);

  const invoke = useCallback((action: (() => Promise<unknown>) | undefined): void => {
    if (!action) {
      setClientError('Terminal requires the Cheshi Electron app.');
      return;
    }
    runAction(action);
  }, [runAction]);

  return {
    state,
    error: clientError || state.error || '',
    registerHost,
    newSession: () => invoke(desktopApi && (() => desktopApi.newTerminalSession())),
    selectSession: (sessionId) => invoke(
      desktopApi && (() => desktopApi.selectTerminalSession(sessionId)),
    ),
    closeSession: (sessionId) => invoke(
      desktopApi && (() => desktopApi.closeTerminalSession(sessionId)),
    ),
    closeAllSessions: () => invoke(desktopApi && (async () => {
      let nextState = state;
      for (const { id } of state.sessions) {
        const result = await desktopApi.closeTerminalSession(id);
        const normalized = normalizeTerminalState(result);
        if (!normalized) return result;
        nextState = normalized;
        if (nextState.error) break;
      }
      return nextState;
    })),
    selectPane: (sessionId, paneId) => invoke(
      desktopApi && (() => desktopApi.selectTerminalPane(sessionId, paneId)),
    ),
    splitPane: async (sessionId, paneId, direction) => {
      if (!desktopApi) { setClientError('Terminal requires the Cheshi Electron app.'); return false; }
      try {
        const next = await desktopApi.splitTerminalPane(sessionId, paneId, direction);
        applyState(next);
        const normalized = normalizeTerminalState(next);
        return normalized !== null && !normalized.error;
      } catch (error) {
        setClientError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    resizeSplit: (sessionId, splitId, ratio) => invoke(
      desktopApi && (() => desktopApi.resizeTerminalSplit(sessionId, splitId, ratio)),
    ),
    closePane: (sessionId, paneId) => invoke(
      desktopApi && (() => desktopApi.closeTerminalPane(sessionId, paneId)),
    ),
  };
}
