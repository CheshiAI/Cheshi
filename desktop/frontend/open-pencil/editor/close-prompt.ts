import { confirmDocumentClose, type ClosableDocument, type CloseChoice } from '../../../../vendor/open-pencil/src/app/document/close/controller';
import { requestHost } from './host';

let pending: Promise<unknown> = Promise.resolve();

/** Keep the upstream close/save contract while asking through Cheshi's shared modal. */
export function requestDocumentClose(document: ClosableDocument, documentName: string) {
  const result = pending.then(() => confirmDocumentClose(document, async (): Promise<CloseChoice> => {
    // A person deciding whether to save must not race a bridge request timeout.
    const choice = await requestHost<unknown>('confirm-close', { documentName }, null);
    return choice === 'save' || choice === 'discard' ? choice : 'cancel';
  })).catch(() => 'cancel' as const);
  // Host save errors are already reported by OriginalCanvasEditor. A failed save
  // or disconnected host cancels closing and leaves the document and draft intact.
  pending = result;
  return result;
}
