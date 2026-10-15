import { AudioLines, RefreshCw, X } from 'lucide-react';
import { useId, useRef, useState, type RefObject } from 'react';
import { NeumorphicButton, SlidingSidePanel, Tooltip } from '../../shared/ui';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import styles from './VoiceRecordingsSidebar.module.css';
import type { useVoiceRecordings } from './useVoiceRecordings';
import { VoiceRecordingsList } from './VoiceRecordingsList';

export function VoiceRecordingsSidebar({ blurSourceRef, recordings, selectedId, onSelect, onOpenSettings }: {
  blurSourceRef?: RefObject<HTMLElement | null>; recordings: ReturnType<typeof useVoiceRecordings>; selectedId: string | null; onSelect(id: string): void; onOpenSettings?: () => void;
}) {
  const id = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const listRef = useAutoHideScrollbars<HTMLDivElement>();
  const [open, setOpen] = useState(false);
  const close = () => {
    railRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    setOpen(false);
  };
  return <aside className={styles.inspector} data-open={open} aria-label="Voice tools"
    onKeyDown={event => {
      if (!open || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
    <SlidingSidePanel open={open} className={styles.panel}>
      <section className={styles.content} id={id} aria-labelledby={`${id}-button`}>
        <header className={styles.heading}>
          <SidebarPanelTitle title="RECORDINGS" />
          <div className={styles.actions}>
          <TooltipButton variant="ghost" size="icon" aria-label="Refresh recordings" title="Refresh recordings"
            disabled={recordings.loading} onClick={() => { void recordings.refresh(); }}><RefreshCw aria-hidden="true" /></TooltipButton>
          <TooltipButton variant="ghost" size="icon" aria-label="Close recordings panel" title="Close recordings panel"
            onClick={close}><X aria-hidden="true" /></TooltipButton>
          </div>
        </header>
        <div ref={listRef} className={styles.list}>
          <VoiceRecordingsList {...recordings} selectedId={selectedId} onSelect={onSelect} onOpenSettings={onOpenSettings} />
        </div>
      </section>
    </SlidingSidePanel>
    <div ref={railRef} className={styles.rail} role="group" aria-label="Voice panels">
      <Tooltip content="Recordings" blurSourceRef={blurSourceRef}>{triggerProps => (
        <NeumorphicButton {...triggerProps} variant="ghost" size="icon" active={open}
          id={`${id}-button`} aria-label="Recordings" aria-controls={id} aria-expanded={open}
          onClick={() => { if (!open) void recordings.refresh(); setOpen(current => !current); }}><AudioLines aria-hidden="true" /></NeumorphicButton>
      )}</Tooltip>
    </div>
  </aside>;
}
