import { Mic, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useVoiceRecordings } from './useVoiceRecordings';
import { VoiceRecordingDetail } from './VoiceRecordingDetail';
import { SidebarPanelHeader, SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { VoiceRecordingsSidebar } from './VoiceRecordingsSidebar';
import styles from './VoiceView.module.css';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { VoiceRecordingsApi } from '../../../../shared/voice-recordings';

export function VoiceView({ onCloseWorkspace, recordingsApi = cheshiDesktop?.voiceRecordings, onOpenSettings }: {
  onCloseWorkspace?: () => void; recordingsApi?: VoiceRecordingsApi; onOpenSettings?: () => void;
}) {
  const recordings = useVoiceRecordings(recordingsApi);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = recordings.snapshot?.status === 'ready'
    ? recordings.snapshot.recordings.find(recording => recording.id === selectedId) : undefined;
  if (selectedId !== null && recordings.snapshot?.status === 'ready' && !selected) setSelectedId(null);
  const sourceRef = useRef<HTMLElement>(null);
  return <main ref={sourceRef} className={styles.root} aria-label="Voice workspace">
    <SidebarPanelHeader title="VOICE" titleContent={
      <SidebarPanelTitle as="h2" title="VOICE" icon={<Mic aria-hidden="true" />} />
    } actions={<>
      {onCloseWorkspace && <TooltipButton variant="ghost" size="icon"
        aria-label="Close Voice workspace" title="Close Voice workspace" onClick={onCloseWorkspace}>
        <X aria-hidden="true" />
      </TooltipButton>}
    </>} />
    <div className={styles.body}>
      <section className={styles.content} aria-label="Recording details">
        {selected ? <VoiceRecordingDetail key={selected.id} recording={selected} api={recordingsApi?.detail} />
          : <p className={styles.empty}>No recording selected.</p>}
      </section>
      <VoiceRecordingsSidebar blurSourceRef={sourceRef} recordings={recordings} selectedId={selectedId} onSelect={setSelectedId} onOpenSettings={onOpenSettings} />
    </div>
  </main>;
}
