import type { PhrasingContent, Root } from 'mdast';
import { flashSourceTarget } from '../../../../shared/flash-memory';

function label(nodes: PhrasingContent[]): string {
  return nodes.map(node => node.type === 'text' ? node.value
    : node.type === 'strong' || node.type === 'emphasis' ? label(node.children) : '\uFFFC').join('').trim();
}

/** Decorate only a source section followed by a quote and a valid memory link. */
export function remarkFlashSourceHeading() {
  return (tree: Root) => {
    tree.children.forEach((node, index) => {
      if ((node.type !== 'paragraph' && node.type !== 'heading') || label(node.children) !== '출처') return;
      const quote = tree.children[index + 1], link = tree.children[index + 2];
      if (quote?.type !== 'blockquote' || link?.type !== 'paragraph'
        || !link.children.some(child => child.type === 'link' && flashSourceTarget(child.url))) return;
      node.data = { ...node.data, hName: 'p', hProperties: { ...node.data?.hProperties, 'data-flash-source-heading': true } };
    });
  };
}
