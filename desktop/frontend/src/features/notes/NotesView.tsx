import { PanelRight, StickyNote } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { AppleNote } from '../../../../shared/apple-notes';
import { SidebarToggle, SidebarPanelHeader } from '../../shared/ui';
import { AppleNotesBrowser } from './AppleNotesBrowser';
import styles from './AppleNotes.module.css';

export function NotesView({ onAttach, attachmentDisabled, rightSidebarOpen, onToggleRightSidebar,
  active = true, sidebarActive = false, sidebarTarget, onOpen }: {
  onAttach: (note: AppleNote) => Promise<boolean>;
  attachmentDisabled: boolean;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  active?: boolean;
  sidebarActive?: boolean;
  sidebarTarget?: HTMLElement | null;
  onOpen?: () => void;
}) {
  const [opened, setOpened] = useState(active || sidebarActive);
  useEffect(() => { if (active || sidebarActive) setOpened(true); }, [active, sidebarActive]);
  const api = cheshiDesktop?.appleNotes;
  if (!opened && !active && !sidebarActive) return null;
  const renderHeader = () => <SidebarPanelHeader title="MEMO" icon={<StickyNote aria-hidden="true" />} actions={
    <SidebarToggle raised size="icon"
      aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
      aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></SidebarToggle>
  } />;
  const unavailable = <p className={styles.unavailable}>Apple 메모 연동은 macOS용 Cheshi에서 사용할 수 있습니다.</p>;
  return <main className={styles.workspace} aria-label="Memo" hidden={!active}>
    {api?.available ? <AppleNotesBrowser api={api} onAttach={onAttach} attachmentDisabled={attachmentDisabled}
      renderHeader={renderHeader} sidebarTarget={sidebarTarget} onOpen={onOpen} />
      : <>{renderHeader()}{unavailable}{sidebarTarget && createPortal(<>
        <SidebarPanelHeader title="MEMO" icon={<StickyNote aria-hidden="true" />} />{unavailable}
      </>, sidebarTarget)}</>}
  </main>;
}
