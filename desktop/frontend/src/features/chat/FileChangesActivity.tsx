import { FileCode2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { LiquidGlassPanel, NeumorphicButton, NeumorphicSurface } from '../../shared/ui';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { ChatActivityItem, ChatFileChange } from './model';
import styles from './FileChangesActivity.module.css';

const MAX_RENDERED_DIFF_LINES = 1_200;

type DiffLineKind = 'add' | 'remove' | 'context' | 'header';

interface DiffLine {
  kind: DiffLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

interface DiffMetrics {
  additions: number;
  deletions: number;
  lines: DiffLine[];
  truncated: boolean;
}

interface FileChangesActivityProps {
  item: ChatActivityItem;
  onReview: (itemId: string, path?: string) => void;
}

interface FileChangesReviewPanelProps {
  item: ChatActivityItem;
  initialPath: string | null;
  onClose: () => void;
}

function displayPath(value: string): string {
  const path = value.startsWith('file://') ? value.slice('file://'.length) : value;
  const workspaceRoot = cheshiDesktop?.workspaceRoot.replace(/\/+$/, '');
  return workspaceRoot && path.startsWith(`${workspaceRoot}/`)
    ? path.slice(workspaceRoot.length + 1)
    : path;
}

function parseDiff(change: ChatFileChange): DiffMetrics {
  const sourceLines = change.diff.replaceAll('\r\n', '\n').split('\n');
  if (sourceLines.at(-1) === '') sourceLines.pop();
  const hasHunks = sourceLines.some((line) => line.startsWith('@@ '));
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let oldCursor = 0;
  let newCursor = 0;

  const append = (line: DiffLine): void => {
    if (lines.length < MAX_RENDERED_DIFF_LINES) lines.push(line);
  };

  for (const line of sourceLines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldCursor = Number(hunk[1]);
      newCursor = Number(hunk[2]);
      append({ kind: 'header', content: line, oldLine: null, newLine: null });
      continue;
    }
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('\\ No newline at end of file')
    ) {
      append({ kind: 'header', content: line, oldLine: null, newLine: null });
      continue;
    }

    if (line.startsWith('+')) {
      additions += 1;
      append({ kind: 'add', content: line.slice(1), oldLine: null, newLine: newCursor || null });
      if (newCursor) newCursor += 1;
      continue;
    }
    if (line.startsWith('-')) {
      deletions += 1;
      append({ kind: 'remove', content: line.slice(1), oldLine: oldCursor || null, newLine: null });
      if (oldCursor) oldCursor += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      append({ kind: 'context', content: line.slice(1), oldLine: oldCursor || null, newLine: newCursor || null });
      if (oldCursor) oldCursor += 1;
      if (newCursor) newCursor += 1;
      continue;
    }

    if (!hasHunks && change.kind === 'add') {
      additions += 1;
      newCursor += 1;
      append({ kind: 'add', content: line, oldLine: null, newLine: newCursor });
      continue;
    }
    if (!hasHunks && change.kind === 'delete') {
      deletions += 1;
      oldCursor += 1;
      append({ kind: 'remove', content: line, oldLine: oldCursor, newLine: null });
      continue;
    }
    append({ kind: 'context', content: line, oldLine: null, newLine: null });
  }

  return {
    additions,
    deletions,
    lines,
    truncated: sourceLines.length > MAX_RENDERED_DIFF_LINES,
  };
}

function aggregateMetrics(changes: ChatFileChange[]): Pick<DiffMetrics, 'additions' | 'deletions'> {
  return changes.reduce((totals, change) => {
    const metrics = parseDiff(change);
    return {
      additions: totals.additions + metrics.additions,
      deletions: totals.deletions + metrics.deletions,
    };
  }, { additions: 0, deletions: 0 });
}

function ChangeStats({ additions, deletions }: Pick<DiffMetrics, 'additions' | 'deletions'>) {
  return (
    <span className={styles.stats} aria-label={`${additions} additions, ${deletions} deletions`}>
      <b className={styles.additions}>+{additions}</b>
      <b className={styles.deletions}>−{deletions}</b>
    </span>
  );
}

function activityTitle(item: ChatActivityItem, fileCount: number): string {
  const files = fileCount === 1 ? 'file' : 'files';
  if (item.status === 'inProgress') return `Editing ${fileCount} ${files}`;
  if (item.status === 'failed') return `Failed to edit ${fileCount} ${files}`;
  if (item.status === 'declined') return `Declined changes to ${fileCount} ${files}`;
  return `Edited ${fileCount} ${files}`;
}

function FileRow({ change, onClick, selected = false }: { change: ChatFileChange; onClick: () => void; selected?: boolean }) {
  const metrics = useMemo(() => parseDiff(change), [change]);
  const path = displayPath(change.path);
  return (
    <button
      className={styles.fileRow}
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
    >
      <NeumorphicSurface as="span" raised className={styles.changeKind} data-kind={change.kind} aria-hidden="true">
        {change.kind === 'add' ? 'A' : change.kind === 'delete' ? 'D' : 'M'}
      </NeumorphicSurface>
      <span className={styles.path} title={path}>{path}</span>
      <ChangeStats additions={metrics.additions} deletions={metrics.deletions} />
    </button>
  );
}

export function FileChangesActivity({ item, onReview }: FileChangesActivityProps) {
  const changes = item.changes ?? [];
  const metrics = useMemo(() => aggregateMetrics(changes), [changes]);
  return (
    <LiquidGlassPanel as="article" className={styles.card} data-status={item.status} data-liquid-glass-backdrop="true">
      <header className={styles.cardHeader}>
        <NeumorphicSurface as="span" raised className={styles.cardIcon}><FileCode2 aria-hidden="true" /></NeumorphicSurface>
        <div className={styles.cardTitle}>
          <strong>{activityTitle(item, changes.length)}</strong>
          <ChangeStats additions={metrics.additions} deletions={metrics.deletions} />
        </div>
        {item.status === 'inProgress' && (
          <div className={styles.cardActions}><i aria-label="In progress" /></div>
        )}
      </header>
      {changes.length > 0 && (
        <div className={styles.fileList}>
          {changes.map((change) => (
            <FileRow
              change={change}
              key={`${change.path}:${change.movePath ?? ''}`}
              onClick={() => onReview(item.id, change.path)}
            />
          ))}
        </div>
      )}
    </LiquidGlassPanel>
  );
}

export function FileChangesReviewPanel({ item, initialPath, onClose }: FileChangesReviewPanelProps) {
  const changes = item.changes ?? [];
  const [selectedPath, setSelectedPath] = useState(initialPath ?? changes[0]?.path ?? '');
  const totals = useMemo(() => aggregateMetrics(changes), [changes]);

  useEffect(() => {
    if (initialPath && changes.some((change) => change.path === initialPath)) {
      setSelectedPath(initialPath);
      return;
    }
    setSelectedPath((currentPath) => (
      changes.some((change) => change.path === currentPath)
        ? currentPath
        : changes[0]?.path ?? ''
    ));
  }, [changes, initialPath]);

  const selectedChange = changes.find((change) => change.path === selectedPath) ?? changes[0] ?? null;
  const selectedMetrics = useMemo(
    () => selectedChange ? parseDiff(selectedChange) : null,
    [selectedChange],
  );

  return (
    <LiquidGlassPanel
      as="section"
      className={styles.reviewPanel}
      data-liquid-glass-surface="side-panel"
      aria-label="File changes review"
    >
      <header className={styles.reviewHeader}>
        <div className={styles.reviewHeading}>
          <strong>Review</strong>
          <span>{activityTitle(item, changes.length)}</span>
        </div>
        <div className={styles.reviewHeaderActions}>
          <div className={styles.reviewHeaderStats}>
            <span className={styles.reviewFileCount}>
              {changes.length === 1 ? '1 changed file' : `${changes.length} changed files`}
            </span>
            <ChangeStats additions={totals.additions} deletions={totals.deletions} />
          </div>
          <NeumorphicButton
            raised
            className="sidebar-heading-action"
            aria-label="Close file changes review"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </NeumorphicButton>
        </div>
      </header>
      <nav className={styles.reviewFiles} aria-label="Changed files">
        {changes.map((change) => (
          <FileRow
            change={change}
            key={`${change.path}:${change.movePath ?? ''}`}
            selected={change.path === selectedChange?.path}
            onClick={() => setSelectedPath(change.path)}
          />
        ))}
      </nav>
      {selectedChange && selectedMetrics ? (
        <section className={styles.diffArea}>
          <div className={styles.diffScroller} role="region" aria-label={`Diff for ${displayPath(selectedChange.path)}`} tabIndex={0}>
            <div className={styles.diffContent}>
              {selectedMetrics.lines.length > 0 ? selectedMetrics.lines.map((line, index) => {
                const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : line.kind === 'context' ? ' ' : '';
                return (
                  <div className={styles.diffLine} data-kind={line.kind} key={`${index}:${line.kind}`}>
                    <span>{line.oldLine ?? ''}</span>
                    <span>{line.newLine ?? ''}</span>
                    <code>{marker}{line.content}</code>
                  </div>
                );
              }) : <p className={styles.emptyDiff}>No textual diff is available for this file.</p>}
              {selectedMetrics.truncated && <p className={styles.truncated}>Diff truncated after {MAX_RENDERED_DIFF_LINES.toLocaleString()} lines.</p>}
            </div>
          </div>
        </section>
      ) : <p className={styles.emptyReview}>No file changes are available to review.</p>}
    </LiquidGlassPanel>
  );
}
