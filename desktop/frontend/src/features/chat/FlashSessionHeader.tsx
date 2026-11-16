import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageSquareText, RefreshCw } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { SidebarPanelHeader } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { flashStatusPresentation, observeFlashMemory, type FlashStatusView } from './flashMemoryStatus';
import styles from './FlashSessionHeader.module.css';

export function FlashSessionHeader({ actions }: { actions: ReactNode }) {
  const api = cheshiDesktop?.flashMemory;
  const [view, setView] = useState<FlashStatusView>({ status: null, retrying: false, connectionError: false });
  const observer = useRef<ReturnType<typeof observeFlashMemory> | null>(null);
  useEffect(() => {
    if (!api) return;
    const current = observeFlashMemory(api, setView);
    observer.current = current;
    return () => { current.stop(); observer.current = null; };
  }, [api]);
  const presentation = view.connectionError
    ? { label: 'Unavailable', detail: 'Cannot read Flash status. Retry, or restart Cheshi if it was updated.', retryable: true }
    : view.status ? flashStatusPresentation(view.status)
    : { label: api ? 'Checking' : undefined, detail: '', retryable: false };
  return <>
    <SidebarPanelHeader title="SESSION" icon={<MessageSquareText aria-hidden="true" />}
      description={presentation.label && `Flash · ${presentation.label}`} actions={actions} />
    {presentation.detail && <div className={styles.status} aria-label="Flash memory status">
      <span role="status" aria-live="polite">{presentation.detail}</span>
      {presentation.retryable && <TooltipButton size="icon" title="Retry Flash synchronization"
        aria-label="Retry Flash synchronization" disabled={view.retrying} onClick={() => observer.current?.retry()}>
        <RefreshCw aria-hidden="true" />
      </TooltipButton>}
    </div>}
  </>;
}
