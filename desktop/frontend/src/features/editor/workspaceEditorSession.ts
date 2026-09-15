import type { EditorSession } from '../../../../shared/editor-session';
import type { WorkspaceFileReadResult } from '../../cheshiDesktop';
import type { WorkspaceTab } from './workspaceEditorModel';
import { normalizeWorkspaceEditorContent } from './workspaceFileLoad';

export function captureEditorSession(tabs: readonly WorkspaceTab[], selectedPath: string | null): EditorSession {
  const paths = tabs.map(tab => tab.path);
  return { version: 1, paths, selectedPath: paths.includes(selectedPath ?? '') ? selectedPath : paths[0] ?? null };
}

export async function restoreEditorSession(
  session: EditorSession, read: (path: string) => Promise<WorkspaceFileReadResult>, generation: () => number,
) {
  const tabs: WorkspaceTab[] = [];
  // Read sequentially to avoid a burst of file contents and preview data at startup.
  for (const path of session.paths) {
    try {
      const result = await read(path);
      const content = normalizeWorkspaceEditorContent(result.content ?? '');
      tabs.push({ path, file: result.file, previewDataUrl: result.dataUrl, sourceExcerpt: null,
        savedContent: content, draftContent: content, conflictMessage: null, loadGeneration: generation() });
    } catch { /* Missing or unreadable files must not block the remaining tabs. */ }
  }
  const selectedPath = tabs.some(tab => tab.path === session.selectedPath) ? session.selectedPath : tabs[0]?.path ?? null;
  return { tabs, selectedPath };
}
