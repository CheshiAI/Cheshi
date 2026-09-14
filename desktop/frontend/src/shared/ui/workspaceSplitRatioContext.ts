import { createContext } from 'react';

/** Connect the outer workspace layout to the editor's single session writer. */
export const WorkspaceSplitRatioContext = createContext<{
  ratio: number;
  restore: (ratio: number) => void;
} | null>(null);
