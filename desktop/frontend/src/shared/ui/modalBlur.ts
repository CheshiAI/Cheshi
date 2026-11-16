const TOP_ATTRIBUTE = 'data-modal-blur-top';
const documents = new WeakMap<Document, ReturnType<typeof createModalStack>>();

function restoreAttribute(element: Element, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Only the top dialog owns the dim; preserve native focus and host blocking. */
function createModalStack(document: Document) {
  const dialogs = new Map<HTMLDialogElement, string | null>();
  let modalOpen = false;
  const update = () => {
    const top = [...dialogs.keys()].filter(dialog => dialog.isConnected && dialog.open).at(-1);
    if (modalOpen !== Boolean(top)) {
      modalOpen = Boolean(top);
      document.defaultView?.workspaceSurface?.reportModal(modalOpen);
    }
    for (const dialog of dialogs.keys()) dialog.setAttribute(TOP_ATTRIBUTE, String(dialog === top));
  };
  const Observer = document.defaultView!.MutationObserver;
  const observer = new Observer(update);
  const observe = () => {
    observer.disconnect();
    observer.observe(document.body, { childList: true });
    for (const dialog of dialogs.keys()) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  };
  return {
    register(dialog: HTMLDialogElement) {
      dialogs.set(dialog, dialog.getAttribute(TOP_ATTRIBUTE));
      observe(); update();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        restoreAttribute(dialog, TOP_ATTRIBUTE, dialogs.get(dialog) ?? null);
        dialogs.delete(dialog);
        update();
        if (dialogs.size) observe();
        else {
          observer.disconnect();
          documents.delete(document);
        }
      };
    },
  };
}

export function registerModalLayer(dialog: HTMLDialogElement) {
  const document = dialog.ownerDocument;
  let controller = documents.get(document);
  if (!controller) {
    controller = createModalStack(document);
    documents.set(document, controller);
  }
  return controller.register(dialog);
}
