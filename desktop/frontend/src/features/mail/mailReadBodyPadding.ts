const QUOTATION = 'blockquote[type="cite"]';
const PADDED = 'data-cheshi-mail-read-padding';
const STRUCTURAL_CONTAINERS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'OL', 'DL']);

/** Add reading-view spacing around authored runs, leaving quoted subtrees intact. */
export function applyMailReadBodyPadding(body: HTMLElement) {
  const doc = body.ownerDocument;
  const pad = (container: HTMLElement) => {
    if (container.matches(QUOTATION) || container.hasAttribute(PADDED)) return;
    // Keep table rows and list items in their original structural parents.
    if (STRUCTURAL_CONTAINERS.has(container.tagName)) {
      for (const child of container.children) pad(child as HTMLElement);
      return;
    }
    let run: HTMLElement | undefined;
    for (const node of [...container.childNodes]) {
      if (node.nodeType === 1) {
        const element = node as HTMLElement;
        if (element.matches(QUOTATION) || element.hasAttribute(PADDED)
          || ['STYLE', 'META', 'LINK'].includes(element.tagName)) {
          run = undefined;
          continue;
        }
        if (element.querySelector(QUOTATION)) {
          run = undefined;
          pad(element);
          continue;
        }
      } else if (node.nodeType !== 3 || (!run && !node.textContent?.trim())) continue;
      if (!run) {
        // A private tag avoids applying the sender's div/section rules to this wrapper.
        run = doc.createElement('cheshi-mail-body');
        run.setAttribute(PADDED, '');
        run.style.cssText = 'display:block!important;box-sizing:border-box!important;min-width:0!important;margin:0!important;padding:0 16px!important';
        container.insertBefore(run, node);
      }
      run.append(node);
    }
  };
  pad(body);
}
