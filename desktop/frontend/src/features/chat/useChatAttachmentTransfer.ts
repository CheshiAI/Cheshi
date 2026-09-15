import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { errorMessage } from '../../shared/errorMessage';
import type { CodexChatAttachment } from '../../cheshiDesktop';
import { chatDroppedFiles, chatTransferFiles, hasChatTransferFiles, importChatTransferFiles, mergeChatAttachments } from './attachmentTransferModel';

interface ChatAttachmentTransferOptions {
  scopeKey: string;
  disabled: boolean;
  inactive?: boolean;
  attachments: readonly CodexChatAttachment[];
  captureTask: () => () => boolean;
  importFiles: (files: (File | string)[]) => Promise<CodexChatAttachment[]>;
  addAttachments: (attachments: CodexChatAttachment[]) => void;
  onComplete?: () => void;
}

export function useChatAttachmentTransfer(options: ChatAttachmentTransferOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const pending = useRef<{ scopeKey: string; id: symbol } | null>(null);
  const [status, setStatus] = useState({ scopeKey: options.scopeKey, loading: false, error: null as string | null });
  if (pending.current && pending.current.scopeKey !== options.scopeKey) pending.current = null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);

  const attachFilesToDraft = useCallback(async (files: (File | string)[]): Promise<boolean> => {
    const context = latest.current;
    if (context.disabled || pending.current || files.length === 0) return false;
    const token = { scopeKey: context.scopeKey, id: Symbol() };
    pending.current = token;
    const activeTask = context.captureTask();
    const isCurrent = () => mounted.current && pending.current === token && latest.current.scopeKey === token.scopeKey && !latest.current.disabled && activeTask();
    setStatus({ scopeKey: token.scopeKey, loading: true, error: null });
    try {
      return await importChatTransferFiles(files, {
        isCurrent,
        importFiles: context.importFiles,
        accept: (attachments) => {
          // Capacity is checked after import because identical files share a stored path.
          mergeChatAttachments(latest.current.attachments, attachments);
          latest.current.addAttachments(attachments);
        },
      });
    } catch (error) {
      if (isCurrent()) setStatus({ scopeKey: token.scopeKey, loading: true, error: errorMessage(error) });
      return false;
    } finally {
      if (pending.current === token) {
        pending.current = null;
        if (mounted.current && latest.current.scopeKey === token.scopeKey) {
          setStatus((current) => ({ ...current, loading: false }));
          if (!latest.current.inactive) latest.current.onComplete?.();
        }
      }
    }
  }, []);

  // Explicit workspace actions can attach to a hidden draft. DOM events cannot.
  const transferFiles = useCallback((files: (File | string)[]): Promise<boolean> => {
    if (latest.current.inactive) return Promise.resolve(false);
    return attachFilesToDraft(files);
  }, [attachFilesToDraft]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = chatTransferFiles(event.clipboardData, true);
    if (files.length === 0) return;
    event.preventDefault();
    void transferFiles(files);
  }, [transferFiles]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasChatTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = latest.current.disabled || latest.current.inactive || pending.current ? 'none' : 'copy';
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasChatTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    void transferFiles(chatDroppedFiles(event.dataTransfer));
  }, [transferFiles]);
  const isTransferring = useCallback(() => pending.current !== null, []);
  const dismissError = useCallback(() => setStatus((current) => ({ ...current, error: null })), []);

  return {
    onPaste, onDragOver, onDrop, transferFiles, attachFilesToDraft, isTransferring, dismissError,
    loading: status.scopeKey === options.scopeKey && status.loading,
    error: status.scopeKey === options.scopeKey ? status.error : null,
  };
}
