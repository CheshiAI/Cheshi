import type { TaskActivity } from '../../../../shared/agent-activity';
import type { ChatActivityItem, ChatFileChange } from '../chat/model';

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const recordedPath = (line: string) => /^\/workspace\/[^\r\n]+$/.test(line)
  || /^(?:[.\w@-]+\/)*[.\w@-]+\.[\w-]+$/.test(line);

function legacyChangeKind(lines: string[]): ChatFileChange['kind'] {
  const firstHunk = lines.findIndex(line => hunkHeader.test(line));
  const headers = lines.slice(0, firstHunk);
  const oldPath = headers.find(line => line.startsWith('--- '))?.slice(4).split('\t')[0];
  const newPath = headers.find(line => line.startsWith('+++ '))?.slice(4).split('\t')[0];
  let oldRemaining = 0, newRemaining = 0, oldTotal = 0, newTotal = 0, changed = false;
  for (const line of lines.slice(firstHunk)) {
    const hunk = hunkHeader.exec(line);
    if (hunk) {
      if (oldRemaining || newRemaining) return 'unknown';
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      oldTotal += oldRemaining; newTotal += newRemaining;
    } else if (line.startsWith('-')) { oldRemaining--; changed = true; }
    else if (line.startsWith('+')) { newRemaining--; changed = true; }
    else if (line.startsWith(' ')) { oldRemaining--; newRemaining--; }
    else if (line && line !== '\\ No newline at end of file') return 'unknown';
    if (oldRemaining < 0 || newRemaining < 0) return 'unknown';
  }
  if (oldRemaining || newRemaining || !changed) return 'unknown';
  if (oldPath === '/dev/null') return newPath && newPath !== '/dev/null' && oldTotal === 0 && newTotal > 0 ? 'add' : 'unknown';
  if (newPath === '/dev/null') return oldPath && oldTotal > 0 && newTotal === 0 ? 'delete' : 'unknown';
  // A zero-sided hunk alone can also be an edit to/from an empty file.
  return (oldPath && newPath) || (oldTotal > 0 && newTotal > 0) ? 'update' : 'unknown';
}

/** Old workers joined file paths with unified diffs OR plain added/deleted contents. */
function legacyChanges(text: string, truncated: boolean): ChatFileChange[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (truncated) lines.pop();
  const changes: ChatFileChange[] = [];
  let index = 0;
  while (index < lines.length) {
    const path = lines[index++];
    if (!path || !recordedPath(path)) return [];
    const content: string[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (!line && recordedPath(lines[index + 1] ?? '')) { index++; break; }
      content.push(line); index++;
    }
    const unified = content.some(line => hunkHeader.test(line))
      && content.every(line => !line || /^(?:@@ |[ +\-]|\\ No newline|diff --git |index )/.test(line));
    changes.push({ path, diff: content.join('\n'), kind: unified ? legacyChangeKind(content) : 'unknown', movePath: null,
      ...(unified ? {} : { diffFormat: 'plain' as const }) });
  }
  return changes;
}

export function fileChangesItem(activity: TaskActivity, messageId = activity.id): ChatActivityItem | null {
  if (activity.kind !== 'file') return null;
  const changes = activity.changes ?? legacyChanges(activity.text, activity.truncated);
  if (!changes.length) return null;
  const relative = (path: string) => path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : path;
  return { id: messageId, turnId: activity.turnId, kind: 'activity', activity: 'files', label: 'Files', detail: '',
    status: activity.status === 'running' ? 'inProgress' : activity.status,
    changesTruncated: activity.truncated,
    changes: changes.map(change => ({ ...change, path: relative(change.path), movePath: change.movePath ? relative(change.movePath) : null })) };
}
