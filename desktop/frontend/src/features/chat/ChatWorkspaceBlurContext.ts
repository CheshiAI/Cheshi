import { createContext, type RefObject } from 'react';

/** Portal menus can cover sibling sessions and the dividers between them. */
export const ChatWorkspaceBlurContext = createContext<RefObject<HTMLElement | null> | null>(null);
