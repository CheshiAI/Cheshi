import { AlertTriangle, FileCode2, FolderOpen, Wrench } from 'lucide-react';
import { useMemo } from 'react';

import {
  LiquidGlassPanel,
  LiquidGlassSelect,
  LoadingIndicator,
  NeumorphicButton,
} from '../../shared/ui';
import badgeStyles from '../../shared/ui/Badge.module.css';
import type { LanguageServerMode, LanguageServerStatus } from '../../cheshiDesktop';
import type {
  WorkspaceDiagnostic,
  WorkspaceDiagnosticsStatus,
} from './workspaceDiagnostics';
import { fileRefactoringRecommendation } from './workspaceRefactoring';
import { WorkspaceFileBreadcrumbs } from './WorkspaceFileBreadcrumbs';

interface WorkspaceProblemsPanelProps {
  open: boolean;
  content: string;
  diagnostics: readonly WorkspaceDiagnostic[];
  filePath: string;
  languageServer: LanguageServerStatus | null;
  languageServerConfiguring: boolean;
  status: WorkspaceDiagnosticsStatus;
  onConfigureLanguageServer: (mode: LanguageServerMode) => void;
  onSelectDiagnostic: (diagnostic: WorkspaceDiagnostic) => void;
}

const languageServerModeOptions: ReadonlyArray<{ value: LanguageServerMode; label: string }> = [
  { value: 'disabled', label: 'Parser only' },
  { value: 'auto', label: 'Auto detect' },
  { value: 'custom', label: 'Custom' },
];

function emptyMessage(status: WorkspaceDiagnosticsStatus): string {
  if (status === 'checking') return 'Checking the current draft…';
  if (status === 'unsupported') return 'Diagnostics are not available for this file type yet.';
  if (status === 'error') return 'The current file could not be analyzed.';
  return 'No problems found in the current file.';
}

function languageServerStateLabel(status: LanguageServerStatus): string {
  if (status.state === 'running') return 'Running';
  if (status.state === 'available') return 'Available';
  if (status.state === 'missing') return 'Not found';
  if (status.state === 'error') return 'Error';
  return 'Parser only';
}

export function WorkspaceProblemsPanel({
  open,
  content,
  diagnostics,
  filePath,
  languageServer,
  languageServerConfiguring,
  status,
  onConfigureLanguageServer,
  onSelectDiagnostic,
}: WorkspaceProblemsPanelProps) {
  const refactoringRecommendation = useMemo(() => fileRefactoringRecommendation(content, filePath), [content, filePath]);
  const problemCount = diagnostics.length + (refactoringRecommendation ? 1 : 0);
  const fileName = filePath.split('/').at(-1) ?? filePath;

  return (
    <section
      id="workspace-editor-problems"
      className="workspace-editor-problems"
      aria-label={`Problems in ${filePath}`}
      aria-hidden={!open}
      inert={!open}
      data-open={open ? 'true' : 'false'}
    >
      <WorkspaceFileBreadcrumbs filePath={filePath} />
      <LiquidGlassPanel
        as="header"
        className="workspace-editor-problems-header"
        data-liquid-glass-surface="side-panel"
      >
        <div className="workspace-editor-problems-title">
          <NeumorphicButton
            raised
            size="icon"
            disabled
            aria-hidden="true"
            className="workspace-editor-problems-icon"
          >
            <AlertTriangle aria-hidden="true" />
          </NeumorphicButton>
          <strong>PROBLEMS</strong>
          {problemCount > 0 && (
            <span className={badgeStyles.badge}>{problemCount}</span>
          )}
        </div>
        {(languageServer || status === 'checking') && (
          <div className="workspace-editor-language-server" title={languageServer?.message}>
            {(languageServerConfiguring || status === 'checking') && (
              <LoadingIndicator label={languageServerConfiguring && languageServer
                ? `Configuring ${languageServer.serverName}`
                : `Checking ${fileName}`} />
            )}
            {languageServer && (
              <>
                {!languageServerConfiguring && languageServer.state !== 'disabled' && (
                  <small data-state={languageServer.state}>{languageServerStateLabel(languageServer)}</small>
                )}
                <LiquidGlassSelect
                  ariaLabel={`${languageServer.displayName} language server mode`}
                  className="workspace-editor-language-server-select"
                  disabled={languageServerConfiguring || !open}
                  menuLabel={`${languageServer.displayName} language server mode`}
                  options={languageServerModeOptions}
                  triggerAppearance="flat"
                  value={languageServer.mode}
                  onChange={onConfigureLanguageServer}
                />
                {languageServer.mode === 'custom' && (
                  <button
                    aria-label={`Choose ${languageServer.serverName} executable`}
                    disabled={languageServerConfiguring}
                    title={`Choose ${languageServer.serverName} executable`}
                    type="button"
                    onClick={() => onConfigureLanguageServer('custom')}
                  >
                    <FolderOpen aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </LiquidGlassPanel>

      <div className="workspace-editor-problems-content">
        {diagnostics.length > 0 || refactoringRecommendation ? (
          <ul className="workspace-editor-problem-list">
            {diagnostics.map((diagnostic) => (
              <li key={diagnostic.id}>
                <button
                  className="workspace-editor-problem-row"
                  data-kind={diagnostic.kind}
                  type="button"
                  onClick={() => onSelectDiagnostic(diagnostic)}
                >
                  <AlertTriangle aria-hidden="true" />
                  <span className="workspace-editor-problem-message">
                    <strong>{diagnostic.message}</strong>
                    <small>{diagnostic.source}{diagnostic.code === undefined ? '' : ` ${diagnostic.code}`}</small>
                  </span>
                  <span className="workspace-editor-problem-location">{diagnostic.line}:{diagnostic.column}</span>
                </button>
              </li>
            ))}
            {refactoringRecommendation && (
              <li>
                <div
                  className="workspace-editor-problem-row"
                  data-kind="refactor"
                  role="note"
                  title={refactoringRecommendation}
                >
                  <Wrench aria-hidden="true" />
                  <span className="workspace-editor-problem-message">
                    <strong>Refactoring recommended</strong>
                    <small>{refactoringRecommendation}</small>
                  </span>
                </div>
              </li>
            )}
          </ul>
        ) : (
          <div className="workspace-editor-problems-empty">
            <FileCode2 aria-hidden="true" />
            <span>{emptyMessage(status)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
