import { Facet, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { localFileLinkPath, localPathHref } from '../../../../shared/local-file-link';
import styles from './ChatImportInput.module.css';

export const openChatLocalPath = Facet.define<(href: string) => void, (href: string) => void>({
  combine: values => values[0] ?? (() => {}),
});

interface PathReference { from: number; to: number; path: string; href: string }

/** Match complete references without changing the document or treating URLs/code blocks as files. */
export function chatLocalPathReferences(text: string): PathReference[] {
  const references: PathReference[] = [];
  const tokens = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)|!?\[(?:\\.|[^\]\\\r\n])*\]\((?:<[^>\r\n]*>|[^\s)]+)\)|https?:\/\/[^\s<>]+|(^|[\s(])(?:"(\/(?!\/)[^"\r\n]+)"|'(\/(?!\/)[^'\r\n]+)'|`(\/(?!\/)[^`\r\n]+)`|(\/(?!\/)[^\s<>"'`]+))/gm;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (match[2] || /^https?:/.test(token) || token.startsWith('!')) continue;
    if (token.startsWith('[')) {
      const target = token.slice(token.lastIndexOf('](') + 2, -1).replace(/^<|>$/g, '');
      const path = localFileLinkPath(target);
      if (path?.startsWith('/') && !path.startsWith('//')) {
        references.push({ from: match.index, to: match.index + token.length, path, href: target });
      }
      continue;
    }
    const quoted = match[4] ?? match[5] ?? match[6];
    const path = quoted ?? (match[7] ?? '').replace(/[.,;!?:)\]}]+$/u, '');
    // A single bare /word is a composer command; quoted root paths still work.
    if (!path || (!quoted && !path.slice(1).includes('/'))) continue;
    const href = localPathHref(path);
    if (localFileLinkPath(href) !== path) continue;
    const from = match.index + (match[3]?.length ?? 0);
    references.push({ from, to: from + path.length + (quoted === undefined ? 0 : 2), path, href });
  }
  return references;
}

class LocalPathChip extends WidgetType {
  readonly path: string;
  readonly href: string;

  constructor(path: string, href: string) { super(); this.path = path; this.href = href; }
  eq(other: LocalPathChip) { return this.path === other.path && this.href === other.href; }

  toDOM(view: EditorView) {
    const document = view.dom.ownerDocument;
    const chip = document.createElement('a');
    chip.className = `${styles.chip} ${styles.pathChip}`;
    chip.href = this.href;
    chip.title = this.path;
    chip.tabIndex = -1;
    chip.setAttribute('data-chat-local-path', this.path);
    chip.setAttribute('aria-label', this.path);
    chip.setAttribute('spellcheck', 'false');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
    const outline = document.createElementNS(svg.namespaceURI, 'path');
    // Lucide folder-open (ISC), used as DOM SVG because CodeMirror owns this widget.
    outline.setAttribute('d', 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2');
    svg.append(outline);
    chip.append(svg, this.path.split('/').filter(Boolean).at(-1) ?? this.path);
    chip.addEventListener('click', event => {
      event.preventDefault();
      if (!view.state.readOnly) view.state.facet(openChatLocalPath)(this.href);
    });
    chip.addEventListener('auxclick', event => event.preventDefault());
    return chip;
  }
  ignoreEvent(event: Event) { return event.type === 'click' || event.type === 'auxclick'; }
}

function pathDecorations(state: EditorState) {
  return Decoration.set(chatLocalPathReferences(state.doc.toString()).map(({ from, to, path, href }) =>
    Decoration.replace({ widget: new LocalPathChip(path, href) }).range(from, to)));
}

export const chatLocalPathChips = StateField.define<DecorationSet>({
  create: pathDecorations,
  update: (value, transaction) => transaction.docChanged ? pathDecorations(transaction.state) : value,
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
});
