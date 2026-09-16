import type { AppleNoteDocument } from '../../../../shared/apple-notes-document';
import { isEditableNoteHtml } from '../../../../shared/apple-notes-document';

const headingSelector = 'h1,h2,h3,h4,h5,h6';

function removeLineTerminator(line: Element) {
  let last: ChildNode | null = line.lastChild;
  while (last instanceof Element && last.lastChild) last = last.lastChild;
  if (!(last instanceof Element) || last.tagName !== 'BR') return;
  let parent = last.parentElement;
  last.remove();
  while (parent && parent !== line && !parent.childNodes.length) {
    const next = parent.parentElement;
    parent.remove();
    parent = next;
  }
}

function mergeHeadingLine(div: Element): Element | null {
  const headings = [...div.querySelectorAll(headingSelector)];
  const tag = headings[0]?.tagName;
  if (!tag || headings.some(heading => heading.tagName !== tag)) return null;
  // A native line consists entirely of heading fragments, sometimes wrapped
  // in inline marks. Ordinary containers with separate blocks stay separate.
  const isFragment = (node: Node): boolean => {
    if (!(node instanceof Element)) return !node.textContent?.trim();
    if (node.tagName === tag) return !node.querySelector('div,p,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,hr');
    return ['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'SPAN', 'A'].includes(node.tagName)
      && [...node.childNodes].every(isFragment);
  };
  if (![...div.childNodes].every(isFragment)) return null;
  for (const heading of headings) heading.replaceWith(...heading.childNodes);
  const line = div.ownerDocument.createElement(tag.toLowerCase());
  line.append(...div.childNodes);
  removeLineTerminator(line);
  // An empty native heading line is one blank paragraph, not a large heading.
  if (!line.childNodes.length) return div.ownerDocument.createElement('p');
  return line;
}

export function noteEditorHtml(note: AppleNoteDocument): string {
  if (!isEditableNoteHtml(note.html)) return '';
  const document = new DOMParser().parseFromString(note.html, 'text/html');
  // Apple Notes includes its title as the first body line. Edit that line through
  // the separate title field so saving does not prepend it repeatedly.
  let first = document.body.firstElementChild;
  // Notes can export one title line as several adjacent h1 fragments, including
  // whitespace-only fragments. Match the whole line before descending into it.
  while (first?.tagName === 'DIV' && first.textContent?.trim() !== note.title.trim() && first.firstElementChild) {
    first = first.firstElementChild;
  }
  if (first && first.textContent?.trim() === note.title.trim()) {
    let parent = first.parentElement;
    first.remove();
    while (parent && parent !== document.body && !parent.textContent?.trim() && !parent.children.length) {
      const next = parent.parentElement;
      parent.remove();
      parent = next;
    }
  }
  // Notes uses divs for paragraphs. Normalize leaf divs explicitly; ProseMirror
  // otherwise flattens them and loses line boundaries when importing HTML.
  const lines = [...document.body.querySelectorAll('div')].map(div => ({ div, container: !!div.querySelector('div') }));
  for (const { div, container } of lines.reverse()) {
    const heading = container ? null : mergeHeadingLine(div);
    if (heading) div.replaceWith(heading);
    else if (div.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr')) div.replaceWith(...div.childNodes);
    else {
      const paragraph = document.createElement('p');
      paragraph.append(...div.childNodes);
      // A final br terminates a Notes div; it is not an additional empty line.
      // An empty Notes line (<div><br></div>) becomes an empty paragraph, which
      // ProseMirror gives its own caret placeholder without adding another br.
      removeLineTerminator(paragraph);
      div.replaceWith(paragraph);
    }
  }
  return document.body.innerHTML || '<p></p>';
}
