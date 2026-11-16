import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

export const SidebarStatusContext = createContext<{
  activePanel: string | null;
  target: HTMLElement | null;
}>({ activePanel: null, target: null });

export function SidebarStatusMessage({ panel, children }: { panel: 'chats' | 'canvas' | 'agent-chats' | 'memos'; children: string }) {
  const { activePanel, target } = useContext(SidebarStatusContext);
  return target && activePanel === panel ? createPortal(children, target) : null;
}
