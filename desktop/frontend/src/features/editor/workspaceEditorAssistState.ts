import type { LanguageServerCodeAction, LanguageServerLocation } from '../../cheshiDesktop';
import type { WorkspaceTextEditPreview } from './workspaceTextEdits';

export interface ReferenceSourcePreview {
  content: string;
  startLine: number;
  targetLine: number;
}

export interface WorkspaceEditFilePreview {
  path: string;
  edits: WorkspaceTextEditPreview[];
}

export interface WorkspaceCodeActionsState {
  kind: 'actions';
  actions: LanguageServerCodeAction[];
  loading: boolean;
  error: string | null;
}

export type WorkspaceEditorAssistState = {
  kind: 'references';
  locations: LanguageServerLocation[];
  selectedIndex: number;
  preview: ReferenceSourcePreview | null;
  previewLoading: boolean;
} | WorkspaceCodeActionsState | {
  kind: 'rename';
  value: string;
  placeholder: string;
  submitting: boolean;
} | {
  kind: 'edit-preview';
  title: string;
  files: WorkspaceEditFilePreview[];
  applying: boolean;
};
