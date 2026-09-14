import {
  ChevronRight,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  RotateCw,
} from 'lucide-react';
import {
  Fragment,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type SubmitEvent as ReactSubmitEvent,
} from 'react';

import { useHorizontalOverflow } from '../../shared/useHorizontalOverflow';
import { writeWorkspaceFileTransfer } from '../../shared/workspaceFileTransfer';
import { NeumorphicTextField, SearchClearButton, Tooltip } from '../../shared/ui';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { WorkspaceFileTreeController } from './useWorkspaceFileTreeController';
import { useWorkspaceGitChangedPaths } from './useWorkspaceGitChangedPaths';
import { handleWorkspaceEntryEditKeyDown } from './workspaceEntryEditInteraction';

type WorkspaceFileTreeNameStyle = CSSProperties & {
  '--workspace-file-tree-name-shift': string;
};

const workspaceFileTreeNameEndGap = 8;

interface WorkspaceFileTreeEditRowProps {
  ariaExpanded?: boolean;
  ariaLabel: string;
  ariaSelected?: boolean;
  busy: boolean;
  busyLabel: string;
  depth: number;
  inputRef: RefObject<HTMLInputElement | null>;
  leading: ReactNode;
  placeholder?: string;
  value: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: (event: ReactSubmitEvent<HTMLFormElement>) => void;
}

interface WorkspaceFileTreeRowsProps {
  controller: WorkspaceFileTreeController;
  selectedPath: string | null;
}

function WorkspaceFileTreeName({ name }: { name: string }) {
  const { overflow, ref } = useHorizontalOverflow<HTMLSpanElement>(name);
  const style: WorkspaceFileTreeNameStyle = {
    '--workspace-file-tree-name-shift': `${overflow + workspaceFileTreeNameEndGap}px`,
  };

  return (
    <span className={`workspace-file-tree-name${overflow > 0 ? ' overflowing' : ''}`}>
      <span ref={ref} className="workspace-file-tree-name-track" style={style}>{name}</span>
    </span>
  );
}

function WorkspaceFileTreeEditRow({
  ariaExpanded,
  ariaLabel,
  ariaSelected,
  busy,
  busyLabel,
  depth,
  inputRef,
  leading,
  placeholder,
  value,
  onCancel,
  onChange,
  onSubmit,
}: WorkspaceFileTreeEditRowProps) {
  return (
    <form
      className="workspace-file-tree-entry workspace-file-tree-edit"
      role="treeitem"
      aria-expanded={ariaExpanded}
      aria-selected={ariaSelected}
      style={{ paddingLeft: `${4 + depth * 18}px` }}
      onSubmit={onSubmit}
      onKeyDown={(event) => handleWorkspaceEntryEditKeyDown(event, busy, onCancel)}
      onBlur={(event) => {
        if (!busy && !event.currentTarget.contains(event.relatedTarget)) onCancel();
      }}
    >
      {leading}
      <NeumorphicTextField
        className="workspace-file-tree-edit-field"
        ref={inputRef}
        value={value}
        aria-label={ariaLabel}
        autoComplete="off"
        placeholder={placeholder}
        spellCheck={false}
        readOnly={busy}
        onChange={(event) => onChange(event.target.value)}
        trailingAction={value ? (
          <SearchClearButton
            aria-label="Clear name"
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
          />
        ) : undefined}
      />
      {busy && <RotateCw className="workspace-file-tree-entry-spinner" aria-label={busyLabel} />}
    </form>
  );
}

export function WorkspaceFileTreeRows({ controller, selectedPath }: WorkspaceFileTreeRowsProps) {
  const gitChangedPaths = useWorkspaceGitChangedPaths();
  const {
    activateEntry,
    announcement,
    cancelEntryEdit,
    contextMenu,
    entryEdit,
    entryEditInputRef,
    entryEditValue,
    error,
    expandedDirectories,
    loadingDirectory,
    mutatingPath,
    openContextMenu,
    setEntryEditValue,
    submitCreate,
    submitMove,
    submitRename,
    visibleEntries,
  } = controller;

  const renderCreateEditRow = (depth: number) => {
    if (entryEdit?.mode !== 'create') return null;
    const entryKindLabel = entryEdit.entryKind === 'directory' ? 'folder' : 'file';
    return (
      <WorkspaceFileTreeEditRow
        ariaLabel={`New ${entryKindLabel} name`}
        busy={mutatingPath === entryEdit.directoryPath}
        busyLabel={`Creating ${entryKindLabel}`}
        depth={depth}
        inputRef={entryEditInputRef}
        leading={(
          <>
            <span className="workspace-file-tree-chevron-placeholder" aria-hidden="true" />
            {entryEdit.entryKind === 'directory'
              ? <Folder className="workspace-file-tree-icon" aria-hidden="true" />
              : <FileText className="workspace-file-tree-icon" aria-hidden="true" />}
          </>
        )}
        placeholder={`${entryKindLabel[0]?.toUpperCase() ?? ''}${entryKindLabel.slice(1)} name`}
        value={entryEditValue}
        onCancel={cancelEntryEdit}
        onChange={setEntryEditValue}
        onSubmit={(event) => void submitCreate(event)}
      />
    );
  };

  return (
    <div className="workspace-file-tree-list">
      <div className="workspace-file-tree-list-content" role="tree">
        {entryEdit?.mode === 'create' && entryEdit.directoryPath === '.' && renderCreateEditRow(0)}
        {visibleEntries.map(({ entry, depth }) => {
          const isDirectory = entry.kind === 'directory';
          const isExpanded = expandedDirectories.has(entry.path);
          const isSelected = selectedPath === entry.path;
          const entryLeading = (
            <>
              {isDirectory
                ? <ChevronRight className="workspace-file-tree-chevron" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none' }} aria-hidden="true" />
                : <span className="workspace-file-tree-chevron-placeholder" aria-hidden="true" />}
              {isDirectory && isExpanded
                ? <FolderOpen className="workspace-file-tree-icon" aria-hidden="true" />
                : isDirectory
                  ? <Folder className="workspace-file-tree-icon" aria-hidden="true" />
                  : <FileText className="workspace-file-tree-icon" aria-hidden="true" />}
            </>
          );

          let entryControl: ReactNode;
          if (entryEdit?.mode === 'rename' && entryEdit.entry.path === entry.path) {
            entryControl = (
              <WorkspaceFileTreeEditRow
                ariaExpanded={isDirectory ? isExpanded : undefined}
                ariaLabel={`Rename ${entry.name}`}
                ariaSelected={isSelected}
                busy={mutatingPath === entry.path}
                busyLabel="Renaming"
                depth={depth}
                inputRef={entryEditInputRef}
                leading={entryLeading}
                value={entryEditValue}
                onCancel={cancelEntryEdit}
                onChange={setEntryEditValue}
                onSubmit={(event) => void submitRename(event)}
              />
            );
          } else if (entryEdit?.mode === 'move' && entryEdit.entry.path === entry.path) {
            entryControl = (
              <WorkspaceFileTreeEditRow
                ariaExpanded={isDirectory ? isExpanded : undefined}
                ariaLabel={`Move ${entry.name} to folder`}
                ariaSelected={isSelected}
                busy={mutatingPath === entry.path}
                busyLabel="Moving"
                depth={depth}
                inputRef={entryEditInputRef}
                leading={(
                  <>
                    <span className="workspace-file-tree-chevron-placeholder" aria-hidden="true" />
                    <FolderInput className="workspace-file-tree-icon" aria-hidden="true" />
                  </>
                )}
                placeholder="Destination folder (use . for root)"
                value={entryEditValue}
                onCancel={cancelEntryEdit}
                onChange={setEntryEditValue}
                onSubmit={(event) => void submitMove(event)}
              />
            );
          } else {
            const fullPath = cheshiDesktop?.workspaceRoot
              ? `${cheshiDesktop.workspaceRoot.replace(/\/$/, '')}/${entry.path}`
              : entry.path;
            entryControl = (
              <Tooltip content={fullPath}>
                {(tooltipProps) => (
                  <button
                    {...tooltipProps}
                    className="workspace-file-tree-entry"
                    disabled={mutatingPath === entry.path}
                    draggable={!isDirectory && mutatingPath !== entry.path && Boolean(cheshiDesktop?.workspaceRoot)}
                    role="treeitem"
                    type="button"
                    aria-expanded={isDirectory ? isExpanded : undefined}
                    aria-selected={isSelected}
                    data-git-changed={!isDirectory && gitChangedPaths.has(entry.path) ? 'true' : undefined}
                    data-context-menu-open={contextMenu?.entry?.path === entry.path}
                    style={{ paddingLeft: `${4 + depth * 18}px` }}
                    onClick={() => activateEntry(entry)}
                    onContextMenu={(event) => openContextMenu(event, entry)}
                    onDragStart={(event) => {
                      if (isDirectory || mutatingPath === entry.path || !cheshiDesktop?.workspaceRoot) {
                        event.preventDefault();
                        return;
                      }
                      writeWorkspaceFileTransfer(event.dataTransfer, fullPath);
                    }}
                  >
                    {entryLeading}
                    <WorkspaceFileTreeName name={entry.name} />
                    {mutatingPath === entry.path && (
                      <RotateCw className="workspace-file-tree-entry-spinner" aria-label="Updating" />
                    )}
                  </button>
                )}
              </Tooltip>
            );
          }

          const showCreateRow = isDirectory
            && entryEdit?.mode === 'create'
            && entryEdit.directoryPath === entry.path;
          return (
            <Fragment key={entry.path}>
              {entryControl}
              {showCreateRow && renderCreateEditRow(depth + 1)}
            </Fragment>
          );
        })}
        {loadingDirectory === '.' && visibleEntries.length === 0 && (
          <p className="workspace-file-tree-status">Loading files…</p>
        )}
        {error && <p className="workspace-file-tree-status error">{error}</p>}
        <span className="workspace-file-tree-announcement" aria-live="polite">{announcement}</span>
      </div>
    </div>
  );
}
