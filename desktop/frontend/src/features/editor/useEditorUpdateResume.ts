import { useEffect, useRef, type MutableRefObject } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { updateResumeCoordinator } from '../shell/updateWorkspaceResume';
import type { WorkspaceTab } from './workspaceEditorModel';
import { captureEditorUpdateSnapshot, editorDraftsMatch, parseEditorUpdateSnapshot,
  restoreEditorUpdateTabs, type EditorUpdateSnapshot } from './workspaceUpdateResume';

export function useEditorUpdateResume(options: {
  tabsRef: MutableRefObject<WorkspaceTab[]>;
  selectedPathRef: MutableRefObject<string | null>;
  nextTabGeneration: MutableRefObject<number>;
  savingRef: MutableRefObject<boolean>;
  loading: boolean;
  applyingEdit: boolean;
  problemsOpen: boolean;
  problemsRatio: number;
  replaceTabs(update: (tabs: WorkspaceTab[]) => WorkspaceTab[]): void;
  selectPath(path: string | null): void;
  setProblemsOpen(open: boolean): void;
  setProblemsRatio(ratio: number): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const saved = useRef<EditorUpdateSnapshot | null>(null);
  useEffect(() => updateResumeCoordinator.register('editor', {
    capture() {
      const current = latest.current;
      if (current.loading || current.savingRef.current || current.applyingEdit) throw new Error('Wait for the editor to finish loading or saving before updating.');
      return captureEditorUpdateSnapshot(current.tabsRef.current, current.selectedPathRef.current,
        current.problemsOpen, current.problemsRatio);
    },
    async restore(value) {
      const snapshot = parseEditorUpdateSnapshot(value);
      if (!cheshiDesktop?.readWorkspaceFile) throw new Error('The editor file API is unavailable.');
      const current = latest.current;
      const tabs = await restoreEditorUpdateTabs(snapshot, cheshiDesktop.readWorkspaceFile,
        () => ++current.nextTabGeneration.current);
      current.tabsRef.current = tabs;
      current.replaceTabs(() => tabs);
      current.selectPath(snapshot.selectedPath);
      current.setProblemsOpen(snapshot.problemsOpen);
      current.setProblemsRatio(snapshot.problemsRatio);
    },
    committed(value) { saved.current = parseEditorUpdateSnapshot(value); },
    cancelled() { saved.current = null; },
  }), []);
  return () => editorDraftsMatch(saved.current, latest.current.tabsRef.current);
}
