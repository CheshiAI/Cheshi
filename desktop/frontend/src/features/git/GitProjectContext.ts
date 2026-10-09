import { createContext, useContext } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';

export const GitProjectContext = createContext(cheshiDesktop);
export const useGitDesktop = () => useContext(GitProjectContext);
