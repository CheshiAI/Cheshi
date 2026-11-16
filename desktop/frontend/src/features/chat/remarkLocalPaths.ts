import { localFileLinkPath, localPathHref } from '../../../../shared/local-file-link';

interface PathNode {
  type: string;
  value?: string;
  url?: string;
  children?: PathNode[];
}

function pathLink(path: string): PathNode | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const href = localPathHref(path);
  if (localFileLinkPath(href) !== path) return null;
  return { type: 'link', url: href, children: [{ type: 'text', value: path }] };
}

function linkedText(text: string): PathNode[] {
  // Unquoted paths end at whitespace; quotes/code spans support names containing spaces.
  const paths = /(^|[\s(])(?:"(\/(?!\/)[^"\r\n]+)"|'(\/(?!\/)[^'\r\n]+)'|(\/(?!\/)[^\s<>"'`]+))/gu;
  const nodes: PathNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(paths)) {
    const prefix = match[1] ?? '';
    const quoted = match[2] ?? match[3];
    const path = quoted ?? (match[4] ?? '').replace(/[.,;!?:)\]}]+$/u, '');
    const link = pathLink(path);
    if (!link) continue;
    const start = match.index + prefix.length + (quoted === undefined ? 0 : 1);
    if (start > offset) nodes.push({ type: 'text', value: text.slice(offset, start) });
    nodes.push(link);
    offset = start + path.length;
  }
  if (offset < text.length) nodes.push({ type: 'text', value: text.slice(offset) });
  return nodes;
}

/** Shared message rendering: link local paths without rewriting code blocks or existing links. */
export function remarkLocalPaths() {
  return (tree: PathNode) => {
    const walk = (node: PathNode): void => {
      if (['link', 'linkReference', 'image', 'imageReference', 'code', 'html'].includes(node.type)) return;
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type === 'text' && child.value) {
          if (/\[Image: .+\]/u.test(child.value)) return child;
          return linkedText(child.value);
        }
        if (child.type === 'inlineCode' && child.value) return pathLink(child.value) ?? child;
        walk(child);
        return child;
      });
    };
    walk(tree);
  };
}
