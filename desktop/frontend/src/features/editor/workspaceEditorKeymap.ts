import type { KeyBinding } from '@codemirror/view';
import type { RefObject } from 'react';

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
