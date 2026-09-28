import { generateHTML, type Editor } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { appleNoteFontSize, isEditableNoteHtml } from '../../../../shared/apple-notes-document';
import { noteEditorExtensions } from './appleNotesEditorExtensions';

/** Notes strips blockquotes and merges adjacent lists with different markers. */
export function noteEditorSaveHtml(editor: Editor): string {
  const document = new DOMParser().parseFromString(editor.getHTML(), 'text/html');
  const quotes = [...document.body.querySelectorAll('blockquote')].filter(node => !node.parentElement?.closest('blockquote'));
  let index = 0;
  editor.state.doc.descendants(node => {
    if (node.type.name !== 'blockquote') return true;
    const quote = quotes[index++];
    if (!quote || !editor.markdown) throw new Error('Could not preserve quote formatting.');
    const fragment = document.createDocumentFragment();
    for (const line of editor.markdown.serialize(node.toJSON()).split('\n')) {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      fragment.append(paragraph);
    }
    if (quote.nextElementSibling?.tagName === 'BLOCKQUOTE') {
      const separator = document.createElement('div');
      separator.append(document.createElement('br'));
      fragment.append(separator);
    }
    quote.replaceWith(fragment);
    return false;
  });
  for (const list of document.body.querySelectorAll('ul,ol')) {
    if (!list.nextElementSibling?.matches('ul,ol')) continue;
    const separator = document.createElement('div');
    separator.append(document.createElement('br'));
    list.after(separator);
  }
  return document.body.innerHTML;
}

/** Only uniform native title/heading runs qualify; mixed body sizes stay inline. */
export function restoreNativeHeadings(document: Document) {
  for (const line of document.body.querySelectorAll('p')) {
    if (line.querySelector('div,p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,tt,font')) continue;
    let size: number | undefined;
    let valid = true;
    const inspect = (node: Node, bold: boolean, fontSize?: number) => {
      if (node instanceof Element) {
        if (node.matches('b,strong')) bold = true;
        if (node.matches('span[style]')) fontSize = Number.parseFloat(appleNoteFontSize(node.getAttribute('style')!) ?? '');
        for (const child of node.childNodes) inspect(child, bold, fontSize);
      } else if (node.textContent?.trim()) {
        if (!bold || (fontSize !== 24 && fontSize !== 18) || (size !== undefined && size !== fontSize)) valid = false;
        size = fontSize;
      }
    };
    inspect(line, false);
    if (!valid || size === undefined) continue;
    const heading = document.createElement(size === 24 ? 'h1' : 'h2');
    for (const mark of [...line.querySelectorAll('b,strong,span[style]')].reverse()) mark.replaceWith(...mark.childNodes);
    heading.append(...line.childNodes);
    line.replaceWith(heading);
  }
}

function unsupportedMarkdown(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(unsupportedMarkdown);
  if (!value || typeof value !== 'object') return false;
  const token = value as Record<string, unknown>;
  return ['html', 'image', 'table'].includes(String(token.type)) || Object.values(token).some(unsupportedMarkdown);
}

/** Visible quote markers survive Notes; code blocks and mid-line > stay literal. */
export function restoreQuotedMarkdown(document: Document) {
  let markdown: MarkdownManager | undefined;
  const quoted = (node: Element) => node.tagName === 'P' && /^(?:>\s|>$)/.test(node.textContent ?? '');
  for (const first of [...document.body.querySelectorAll('p')]) {
    if (!first.isConnected || first.closest('pre,code,blockquote') || !quoted(first)) continue;
    const lines: string[] = [];
    const paragraphs: Element[] = [];
    const separators: ChildNode[] = [];
    let current: Element | null = first;
    while (current && quoted(current)) {
      const copy = current.cloneNode(true) as Element;
      for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
      lines.push(copy.textContent ?? '');
      paragraphs.push(current);
      const next: Element | null = current.nextElementSibling;
      const gap: ChildNode[] = [];
      for (let sibling: ChildNode | null = current.nextSibling; sibling && sibling !== next; sibling = sibling.nextSibling) gap.push(sibling);
      if (!next || !quoted(next) || gap.some(node => node.textContent?.trim())) break;
      separators.push(...gap);
      current = next;
    }
    markdown ??= new MarkdownManager({ extensions: noteEditorExtensions() });
    const text = lines.join('\n');
    if (unsupportedMarkdown(markdown.instance.lexer(text))) continue;
    const html = generateHTML(markdown.parse(text), noteEditorExtensions());
    // Markdown may contain raw HTML, images or unsafe URLs. Keep those lines as
    // text instead of widening the editor's conservative import boundary.
    if (!isEditableNoteHtml(html)) continue;
    const fragment = document.createElement('template');
    fragment.innerHTML = html;
    if (fragment.content.children.length !== 1 || fragment.content.firstElementChild?.tagName !== 'BLOCKQUOTE') continue;
    first.before(fragment.content);
    for (const paragraph of paragraphs) paragraph.remove();
    for (const separator of separators) separator.remove();
  }
}
