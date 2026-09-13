import type { EditorState } from '@codemirror/state';

import {
  CODE_EXPLANATION_CONTEXT_LIMIT,
  CODE_EXPLANATION_SELECTION_LIMIT,
  type CodeExplanationRequest,
  type CodeExplanationResult,
} from '../../../../shared/workspace-code-explanation';
import { errorMessage } from '../../shared/errorMessage';

export type CodeExplanationSelection = Omit<CodeExplanationRequest, 'requestId'>;

export interface CodeExplanationState {
  requestId: string;
  selection: CodeExplanationSelection;
  loading: boolean;
  text: string;
  error: string | null;
}

export function captureCodeExplanationSelection(
  state: EditorState,
  path: string,
  firstLine = 1,
): CodeExplanationSelection {
  const { from, to } = state.selection.main;
  if (from === to) throw new Error('Select the code you want explained.');
  if (state.selection.ranges.filter((range) => !range.empty).length > 1) {
    throw new Error('Select one continuous code range to explain.');
  }
  const selectedText = state.sliceDoc(from, to);
  if (!selectedText.trim()) throw new Error('Select the code you want explained.');
  if (selectedText.length > CODE_EXPLANATION_SELECTION_LIMIT) {
    throw new Error('Select up to 32,000 characters to explain.');
  }
  return {
    path,
    startLine: firstLine + state.doc.lineAt(from).number - 1,
    endLine: firstLine + state.doc.lineAt(to - 1).number - 1,
    selectedText,
    contextBefore: state.sliceDoc(Math.max(0, from - CODE_EXPLANATION_CONTEXT_LIMIT), from).slice(-CODE_EXPLANATION_CONTEXT_LIMIT),
    contextAfter: state.sliceDoc(to, Math.min(state.doc.length, to + CODE_EXPLANATION_CONTEXT_LIMIT)).slice(0, CODE_EXPLANATION_CONTEXT_LIMIT),
  };
}

interface CodeExplanationSessionOptions {
  explain: (request: CodeExplanationRequest) => Promise<CodeExplanationResult>;
  cancel: (requestId: string) => Promise<void>;
  onChange: (state: CodeExplanationState | null) => void;
  createRequestId?: () => string;
}

export function createCodeExplanationSession({
  explain,
  cancel,
  onChange,
  createRequestId = () => crypto.randomUUID(),
}: CodeExplanationSessionOptions) {
  let currentRequestId: string | null = null;
  let pendingRequestId: string | null = null;

  const cancelPending = () => {
    currentRequestId = null;
    if (pendingRequestId) void cancel(pendingRequestId).catch(() => undefined);
    pendingRequestId = null;
  };

  return {
    async start(selection: CodeExplanationSelection): Promise<void> {
      cancelPending();
      const requestId = createRequestId();
      currentRequestId = requestId;
      pendingRequestId = requestId;
      const state: CodeExplanationState = { requestId, selection, loading: true, text: '', error: null };
      onChange(state);
      try {
        const result = await explain({ ...selection, requestId });
        if (currentRequestId !== requestId) return;
        onChange({ ...state, loading: false, text: result.text });
      } catch (error) {
        if (currentRequestId !== requestId) return;
        onChange({ ...state, loading: false, error: errorMessage(error) });
      } finally {
        if (pendingRequestId === requestId) pendingRequestId = null;
      }
    },
    dismiss() {
      cancelPending();
      onChange(null);
    },
    dispose: cancelPending,
  };
}
