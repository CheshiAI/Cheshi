import type { WorkspaceEditorSession } from '../../../../shared/workspace-editor-session';
import type { WorkspaceFileReadResult } from '../../cheshiDesktop';
import { normalizeWorkspaceEditorContent } from './workspaceFileLoad';
import type { WorkspaceTab } from './workspaceEditorModel';

export function captureWorkspaceEditorSession(
  tabs: readonly WorkspaceTab[], selectedPath: string | null,
): WorkspaceEditorSession {
  const paths = tabs.map(tab => tab.path);
  return { version: 1, paths, selectedPath: selectedPath && paths.includes(selectedPath) ? selectedPath : paths[0] ?? null };
}

export async function restoreWorkspaceEditorSession(
  session: WorkspaceEditorSession,
  read: (path: string) => Promise<WorkspaceFileReadResult>,
  generation: () => number,
): Promise<{ tabs: WorkspaceTab[]; selectedPath: string | null }> {
  const results = await Promise.allSettled(session.paths.map(async (path): Promise<WorkspaceTab> => {
    const response = await read(path);
    const content = normalizeWorkspaceEditorContent(response.content ?? '');
    return { path, file: response.file, previewDataUrl: response.dataUrl, sourceExcerpt: null,
      savedContent: content, draftContent: content, conflictMessage: null, loadGeneration: generation() };
  }));
  const tabs = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const selectedPath = tabs.some(tab => tab.path === session.selectedPath) ? session.selectedPath : tabs[0]?.path ?? null;
  return { tabs, selectedPath };
}
