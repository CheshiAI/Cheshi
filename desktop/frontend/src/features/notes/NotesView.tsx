import { PanelRight, StickyNote } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { AppleNote } from '../../../../shared/apple-notes';
import { NeumorphicButton, TwoTierHeader, draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';
import { AppleNotesBrowser } from './AppleNotesBrowser';
import styles from './AppleNotes.module.css';

export function NotesView({ onAttach, attachmentDisabled, rightSidebarOpen, onToggleRightSidebar }: {
  onAttach: (note: AppleNote) => Promise<boolean>;
  attachmentDisabled: boolean;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}) {
  const api = cheshiDesktop?.appleNotes;
  return <main className={styles.workspace} aria-label="메모">
    <TwoTierHeader style={draggableWindowRegionStyle} primary={<>
      <div className={styles.heading}><StickyNote aria-hidden="true" /><h1>메모</h1></div>
      <NeumorphicButton raised size="icon" style={nonDraggableWindowRegionStyle}
        aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
        aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></NeumorphicButton>
    </>} />
    {api?.available ? <AppleNotesBrowser api={api} onAttach={onAttach} attachmentDisabled={attachmentDisabled} />
      : <p className={styles.unavailable}>Apple 메모 연동은 macOS용 Cheshi에서 사용할 수 있습니다.</p>}
  </main>;
}
