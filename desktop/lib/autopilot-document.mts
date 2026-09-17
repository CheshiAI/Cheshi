export interface AutopilotSection {
  id: string;
  title: string;
  kind: 'text' | 'code' | 'table';
  preview: string;
}

/** Runs in the isolated browser world. Full text stays in the browser; only an outline is returned. */
export const AUTOPILOT_DOCUMENT_HELPERS = String.raw`
  const documentRoot = document.querySelector('main, [role="main"], article') || document.body;
  const sectionBodies = [];
  let documentTruncated = false;
  let heading = document.title.slice(0, 300) || 'Document';
  let buffer = '', bufferKind = 'text', bufferElement = null;
  const addSection = () => {
    if (!buffer.trim()) return;
    if (sectionBodies.length >= 128) { documentTruncated = true; buffer = ''; return; }
    sectionBodies.push({ id: 'section_' + sectionBodies.length, title: heading,
      kind: bufferKind, preview: buffer.slice(0, 180), text: buffer, element: bufferElement });
    buffer = '';
  };
  const append = (text, kind, element) => {
    text = text.trim();
    if (!text) return;
    if (bufferKind !== kind) addSection();
    bufferKind = kind;
    if (buffer && buffer.length + text.length + 1 > 6000) addSection();
    if (!buffer) bufferElement = element;
    if (buffer) buffer += '\n';
    // Split long paragraphs and code blocks without discarding their tails.
    while (text.length) {
      const take = Math.min(6000 - buffer.length, text.length);
      buffer += text.slice(0, take); text = text.slice(take);
      if (buffer.length >= 6000) { addSection(); bufferElement = element; }
      if (sectionBodies.length >= 128 && text.length) { documentTruncated = true; break; }
    }
  };
  if (documentRoot?.querySelectorAll) {
    const walk = (element, depth = 0) => {
      if (sectionBodies.length >= 128) { documentTruncated = true; return; }
      if (depth > 100) { documentTruncated = true; return; }
      if (element.matches('script,style,noscript,nav,[role="navigation"],button,input,textarea,select') || !visible(element)) return;
      if (/^H[1-6]$/.test(element.tagName)) {
        addSection(); heading = element.innerText.trim().slice(0, 300) || heading; return;
      }
      if (element.matches('pre,table,p,li,dt,dd') || !element.children.length) {
        append(element.innerText || '', element.tagName === 'PRE' ? 'code' : element.tagName === 'TABLE' ? 'table' : 'text', element);
        return;
      }
      for (const node of element.childNodes) {
        if (node.nodeType === 3) append(node.textContent || '', 'text', element);
        else if (node.nodeType === 1) walk(node, depth + 1);
      }
    };
    walk(documentRoot);
    addSection();
  }
  let documentHash = 2166136261;
  for (const section of sectionBodies) for (const char of section.title + '\n' + section.kind + '\n' + section.text) {
    documentHash = Math.imul(documentHash ^ char.charCodeAt(0), 16777619);
  }
  const documentVersion = (documentHash >>> 0).toString(16);
  const sections = sectionBodies.map(({ text, element, ...section }) => section);
`;

export function parseAutopilotSections(value: unknown): AutopilotSection[] {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError('Invalid document outline.');
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new TypeError('Invalid document section.');
    const section = item as Record<string, unknown>;
    if (typeof section.id !== 'string' || !/^section_\d{1,3}$/.test(section.id) || ids.has(section.id)
      || typeof section.title !== 'string' || section.title.length > 300
      || typeof section.preview !== 'string' || section.preview.length > 180
      || (section.kind !== 'text' && section.kind !== 'code' && section.kind !== 'table')) throw new TypeError('Invalid document section.');
    ids.add(section.id);
    return { id: section.id, title: section.title, preview: section.preview, kind: section.kind };
  });
}
