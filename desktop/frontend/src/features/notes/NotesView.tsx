import { PanelRight, StickyNote } from 'lucide-react';
import type { ReactNode } from 'react';
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
  const renderHeader = (refresh?: ReactNode, create?: ReactNode, search?: ReactNode) => <TwoTierHeader className={styles.header} style={draggableWindowRegionStyle} primary={<>
      <div className={styles.heading}>
        <NeumorphicButton raised aria-hidden="true" className={`theme-toggle ${styles.titleMark}`} disabled>
          <StickyNote aria-hidden="true" />
        </NeumorphicButton>
        <h1>Memo</h1>
      </div>
      <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
        {search}
        {refresh}
        {create}
        <NeumorphicButton raised size="icon"
          aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
          aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></NeumorphicButton>
      </div>
    </>} />;
  return <main className={styles.workspace} aria-label="Memo">
    {api?.available ? <AppleNotesBrowser api={api} onAttach={onAttach} attachmentDisabled={attachmentDisabled} renderHeader={renderHeader} />
      : <>{renderHeader()}<p className={styles.unavailable}>Apple 메모 연동은 macOS용 Cheshi에서 사용할 수 있습니다.</p></>}
  </main>;
}
