import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { RefObject } from 'react';
import { cheshiDesktop as workspace, type LanguageServerStatus } from '../../cheshiDesktop';
import { languageServerLanguageForPath, normalizeLanguageServerCompletionResult } from './languageServerDiagnostics';
import { assertLanguageServerValue, canUseLanguageServer, codeMirrorCompletion, editorOffsetAt, languageServerPositionAt } from './workspaceEditorModel';

interface Options {
  api?: Pick<NonNullable<typeof workspace>, 'getLanguageServerCompletions'>;
  languageServersRef: RefObject<LanguageServerStatus[]>;
  editorViewRef: RefObject<EditorView | null>;
  editorPathRef: RefObject<string | null>;
  nextLanguageServerDocumentVersion: (path: string) => number;
}

export function createWorkspaceLanguageServerCompletion({ languageServersRef, editorViewRef,
  editorPathRef, nextLanguageServerDocumentVersion, api = workspace }: Options) {
  return (editorPath: string) => (
    async (context: CompletionContext): Promise<CompletionResult | null> => {
      const language = languageServerLanguageForPath(editorPath);
      const getCompletions = api?.getLanguageServerCompletions;
      const view = context.view;
      if (
        !language
        || !getCompletions
        || !view
        || !canUseLanguageServer(language, languageServersRef.current)
      ) return null;

      const token = context.matchBefore(/[\w$]*/);
      const previousCharacter = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
      if (!context.explicit && (!token || (token.from === token.to && !'.:>'.includes(previousCharacter)))) {
        return null;
      }

      let aborted = false;
      context.addEventListener('abort', () => {
        aborted = true;
      }, { onDocChange: true });
      try {
        const response = normalizeLanguageServerCompletionResult(await getCompletions({
          language,
          path: editorPath,
          content: context.state.doc.toString(),
          version: nextLanguageServerDocumentVersion(editorPath),
          position: languageServerPositionAt(view, context.pos),
        }));
        if (aborted || editorViewRef.current !== view || editorPathRef.current !== editorPath
          || view.state.doc !== context.state.doc) return null;
        assertLanguageServerValue(response, 'Cheshi returned an invalid language server completion response.');

        const firstEditRange = response.items[0]?.textEdit?.range;
        const sharedEditRange = firstEditRange && response.items.every((item) => (
          item.textEdit?.range.start.line === firstEditRange.start.line
          && item.textEdit.range.start.character === firstEditRange.start.character
          && item.textEdit.range.end.line === firstEditRange.end.line
          && item.textEdit.range.end.character === firstEditRange.end.character
        ));
        const requestedFrom = sharedEditRange
          ? editorOffsetAt(view, firstEditRange.start)
          : token?.from ?? context.pos;
        const from = requestedFrom <= context.pos ? requestedFrom : token?.from ?? context.pos;
        const requestedTo = sharedEditRange ? editorOffsetAt(view, firstEditRange.end) : context.pos;
        const to = requestedTo >= from ? requestedTo : context.pos;
        return {
          from,
          to,
          options: response.items.map(codeMirrorCompletion),
          ...(response.isIncomplete ? {} : { validFor: /^[\w$]*$/ }),
        };
      } catch {
        return null;
      }
    }
  );
}
