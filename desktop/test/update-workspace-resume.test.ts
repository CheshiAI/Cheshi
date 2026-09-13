import { describe, expect, test } from 'bun:test';
import type { WorkspaceFileReadResult, WorkspaceFileVersion } from '../frontend/src/cheshiDesktop';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';
import { captureEditorUpdateSnapshot, editorDraftsMatch, parseEditorUpdateSnapshot,
  restoreEditorUpdateTabs } from '../frontend/src/features/editor/workspaceUpdateResume';
import { createUpdateResumeCoordinator, parseUpdateResume } from '../frontend/src/features/shell/updateWorkspaceResume';
import { parseChatUpdateSnapshot, reopenUpdateConversations, type ChatUpdateSnapshot } from '../frontend/src/features/chat/chatUpdateResume';

const file: WorkspaceFileVersion = { path: 'src/main.ts', name: 'main.ts', kind: 'file', fileKind: 'text',
  size: 5, modifiedAt: 1, revision: 'original', hasBom: false, lineEnding: 'lf' };
function tab(draftContent = 'draft'): WorkspaceTab {
  return { path: file.path, file, savedContent: 'saved', draftContent, previewDataUrl: null,
    sourceExcerpt: null, conflictMessage: null, loadGeneration: 1 };
}
async function rejects(operation: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe('update workspace recovery', () => {
  test('preserves dirty contents and original disk baseline when an external edit happened during restart', async () => {
    const snapshot = captureEditorUpdateSnapshot([tab()], file.path, true, 0.3);
    const restored = await restoreEditorUpdateTabs(snapshot, async (): Promise<WorkspaceFileReadResult> => ({
      file: { ...file, revision: 'external' }, content: 'external edit', dataUrl: null,
    }), () => 2);
    expect(restored[0]?.draftContent).toBe('draft');
    expect(restored[0]?.savedContent).toBe('saved');
    expect(restored[0]?.file.revision).toBe('original');
    expect(restored[0]?.conflictMessage).toContain('changed during the update');
  });

  test('loads clean tabs from disk and preserves unavailable dirty files', async () => {
    const clean = captureEditorUpdateSnapshot([tab('saved')], file.path, false, 0.4);
    const restored = await restoreEditorUpdateTabs(clean, async (): Promise<WorkspaceFileReadResult> => ({
      file: { ...file, revision: 'external' }, content: 'changed\r\ncontent', dataUrl: null,
    }), () => 4);
    expect(restored[0]?.draftContent).toBe('changed\ncontent');
    expect(restored[0]?.file.revision).toBe('external');
    const dirty = captureEditorUpdateSnapshot([tab()], file.path, false, 0.4);
    const unavailable = await restoreEditorUpdateTabs(dirty, async () => { throw new Error('missing'); }, () => 5);
    expect(unavailable[0]?.draftContent).toBe('draft');
    expect(unavailable[0]?.conflictMessage).toContain('could not be read');
  });

  test('allows dirty close only after durable save and only for the exact preserved draft', async () => {
    const coordinator = createUpdateResumeCoordinator();
    const tabs = [tab()];
    let preserved: ReturnType<typeof captureEditorUpdateSnapshot> | null = null;
    coordinator.register('editor', {
      capture: () => captureEditorUpdateSnapshot(tabs, file.path, true, 0.3),
      restore() {},
      committed(value) { preserved = parseEditorUpdateSnapshot(value); },
      cancelled() { preserved = null; },
    });
    await rejects(coordinator.prepare('/workspace', async () => { throw new Error('disk full'); }), 'disk full');
    expect(editorDraftsMatch(preserved, tabs)).toBe(false);
    await coordinator.prepare('/workspace', async () => {});
    expect(editorDraftsMatch(preserved, tabs)).toBe(false);
    coordinator.commit();
    expect(editorDraftsMatch(preserved, tabs)).toBe(true);
    expect(editorDraftsMatch(preserved, [{ ...tabs[0]!, draftContent: 'newer edit' }])).toBe(false);
    coordinator.cancel();
    expect(editorDraftsMatch(preserved, tabs)).toBe(false);
  });

  test('cancellation while saving never enables the dirty close bypass', async () => {
    const coordinator = createUpdateResumeCoordinator();
    let committed = false;
    coordinator.register('editor', { capture: () => ({}), restore() {}, committed() { committed = true; } });
    const preparation = coordinator.prepare('/workspace', async () => { coordinator.cancel(); });
    await rejects(preparation, 'cancelled');
    expect(committed).toBe(false);
    expect(() => coordinator.commit()).toThrow();
  });

  test('refuses checkpoint when a participant is busy without saving any partial data', async () => {
    const coordinator = createUpdateResumeCoordinator();
    let saves = 0;
    coordinator.register('chat', { capture() { throw new Error('Active conversation'); }, restore() {} });
    await rejects(coordinator.prepare('/workspace', async () => { saves += 1; }), 'Active conversation');
    expect(saves).toBe(0);
  });

  test('rejects wrong workspace, unsupported schema, malformed tabs, and missing participants', async () => {
    const base = { schemaVersion: 1, workspaceRoot: '/workspace', createdAt: Date.now(), sections: {} };
    expect(() => parseUpdateResume({ ...base, workspaceRoot: '/other' }, '/workspace')).toThrow();
    expect(() => parseUpdateResume({ ...base, schemaVersion: 2 }, '/workspace')).toThrow();
    expect(() => parseUpdateResume({ ...base, createdAt: Date.now() + 120_000 }, '/workspace')).toThrow();
    const editor = captureEditorUpdateSnapshot([tab()], file.path, true, 0.3);
    expect(() => parseEditorUpdateSnapshot({ ...editor, tabs: [{ ...editor.tabs[0], path: '../outside' }] })).toThrow();
    expect(() => parseEditorUpdateSnapshot({ ...editor, tabs: [editor.tabs[0], editor.tabs[0]] })).toThrow();
    expect(() => parseEditorUpdateSnapshot({ ...editor, selectedPath: 'missing' })).toThrow();
    const coordinator = createUpdateResumeCoordinator();
    await rejects(coordinator.restore({ ...base, sections: { editor } }, '/workspace'), 'Cannot restore');
  });

  test('waits for conversation restoration and reports failures rather than acknowledging recovery', async () => {
    const snapshot: ChatUpdateSnapshot = { layout: { type: 'pane', paneId: 'pane' },
      activePaneId: 'pane', sessionIds: { pane: 'thread' } };
    await rejects(reopenUpdateConversations(snapshot, {}), 'could not be reopened');
    await rejects(reopenUpdateConversations(snapshot, { pane: { openSession: async () => false } }), 'could not be reopened');
    const opened: string[] = [];
    await reopenUpdateConversations(snapshot, { pane: { openSession: async (sessionId: string) => {
      await Promise.resolve(); opened.push(sessionId); return true;
    } } });
    expect(opened).toEqual(['thread']);
  });

  test('restores pane layout and session selection without replaying a turn', () => {
    const snapshot: ChatUpdateSnapshot = { layout: { type: 'split', id: 'split', axis: 'columns', ratio: 0.4,
      first: { type: 'pane', paneId: 'left' }, second: { type: 'pane', paneId: 'right' } },
      activePaneId: 'right', sessionIds: { left: 'thread-a', right: 'thread-b' } };
    expect(parseChatUpdateSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseChatUpdateSnapshot({ ...snapshot, activePaneId: 'missing' })).toThrow();
    expect(() => parseChatUpdateSnapshot({ ...snapshot, sessionIds: { other: 'thread' } })).toThrow();
  });
});
