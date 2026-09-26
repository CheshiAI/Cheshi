import type { KeyBinding } from '@codemirror/view';
import type { RefObject } from 'react';
import type { WorkspaceEditorAssistState } from './workspaceEditorAssistState';
import { setSignatureHelpTooltip, signatureHelpTooltipField } from './workspaceEditorModel';

export function workspaceAssistEscapeBinding(
  assistStateRef: RefObject<WorkspaceEditorAssistState | null>,
  closeAssist: () => void,
  cancelSignatureHelp: () => void,
): KeyBinding {
  return { key: 'Escape', run: view => {
    const hasSignature = view.state.field(signatureHelpTooltipField, false) != null;
    const hadAssist = assistStateRef.current !== null;
    closeAssist();
    // Invalidate pending help even when its tooltip has not appeared yet.
    cancelSignatureHelp();
    if (!hadAssist && !hasSignature) return false;
    view.dispatch({ effects: setSignatureHelpTooltip.of(null) });
    return true;
  } };
}

export function workspaceNavigationKeymap(navigate: (direction: 'back' | 'forward') => Promise<void>): KeyBinding[] {
  return [
    { key: 'Mod-[', run: () => { void navigate('back'); return true; } },
    { key: 'Mod-]', run: () => { void navigate('forward'); return true; } },
    { key: 'Ctrl--', run: () => { void navigate('back'); return true; } },
    { key: 'Ctrl-Shift--', run: () => { void navigate('forward'); return true; } },
  ];
}

export function workspaceTabKeymap(
  path: string,
  closeTabRef: RefObject<(path: string | null) => void>,
  tabsRef: RefObject<readonly { path: string }[]>,
  activate: (path: string) => void,
): KeyBinding[] {
  return [
    { key: 'Mod-w', run: () => { closeTabRef.current(path); return true; } },
    ...Array.from({ length: 9 }, (_, index) => ({
      key: `Mod-${index + 1}`,
      run: () => {
        const tab = tabsRef.current[index];
        if (tab) activate(tab.path);
        return true;
      },
    })),
  ];
}
