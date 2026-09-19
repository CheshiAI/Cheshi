import { StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { MAX_BLAME_CONTENT_LENGTH, type GitLineBlame, type GitLineBlameRequest as BlameRequest } from '../../../../shared/git-line-blame';
import { GitLineBlameRequest } from './gitLineBlameRequest';

const showBlame = StateEffect.define<{ line: number; result: GitLineBlame } | null>();

class BlameWidget extends WidgetType {
  private readonly result: GitLineBlame;
  constructor(result: GitLineBlame) { super(); this.result = result; }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = 'cm-git-line-blame';
    span.contentEditable = 'false';
    const result = this.result;
    if (result.status === 'committed') {
      const date = new Date(result.authoredAt).toLocaleString();
      span.textContent = `${result.author} · ${date} · ${result.hash.slice(0, 8)} · ${result.summary}`;
      span.title = `Last changed in ${result.hash}\n${result.author} · ${date}\n${result.summary}`;
    } else {
      span.textContent = result.status === 'uncommitted' ? 'Not committed yet' : 'Git history unavailable';
    }
    return span;
  }
}

export function gitLineBlame(options: {
  path: string;
  lineEnding: 'lf' | 'crlf' | 'cr';
  read: (request: BlameRequest) => Promise<GitLineBlame>;
}): Extension {
  return [ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    readonly requests: GitLineBlameRequest;

    constructor(view: EditorView) {
      this.requests = new GitLineBlameRequest(async (line) => {
        // Git counts LF-delimited lines. CR-only files cannot use editor line numbers.
        if (options.lineEnding === 'cr' || view.state.doc.length > MAX_BLAME_CONTENT_LENGTH) return { status: 'unavailable' };
        const content = view.state.doc.sliceString(0, undefined, options.lineEnding === 'crlf' ? '\r\n' : '\n');
        return options.read({ path: options.path, line, content });
      }, (line, result) => view.dispatch({ effects: showBlame.of({ line, result }) }));
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.requests.reset();
        this.decorations = Decoration.none;
        return;
      }
      for (const transaction of update.transactions) for (const effect of transaction.effects) {
        if (!effect.is(showBlame)) continue;
        this.decorations = effect.value
          ? Decoration.set([Decoration.widget({ widget: new BlameWidget(effect.value.result), side: 1 })
            .range(update.state.doc.line(effect.value.line).to)])
          : Decoration.none;
      }
    }

    destroy(): void { this.requests.reset(); }
  }, {
    decorations: plugin => plugin.decorations,
    eventHandlers: {
      mousemove(event, view) {
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const line = position === null ? null : view.state.doc.lineAt(position).number;
        if (this.requests.hover(line)) view.dispatch({ effects: showBlame.of(null) });
      },
      mouseleave(_event, view) {
        this.requests.reset();
        view.dispatch({ effects: showBlame.of(null) });
      },
    },
  }), EditorView.baseTheme({
    '.cm-git-line-blame': {
      color: 'var(--editor-muted)', fontStyle: 'italic', marginLeft: '24px',
      userSelect: 'none', whiteSpace: 'pre',
    },
  })];
}
