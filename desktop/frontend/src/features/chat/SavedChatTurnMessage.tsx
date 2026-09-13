import { Bookmark } from 'lucide-react';
import type { SavedChatTurnContext } from '../../../../shared/chat-saved-turn-continuation';
import { SavedChatTurnContent } from './SavedChatTurnContent';
import styles from './SavedChatTurnMessage.module.css';

export function SavedChatTurnMessage({ context }: { context: SavedChatTurnContext }) {
  return <section className={styles.context} aria-label="Continued from saved turn">
    <header className={styles.header}>
      <span className={styles.label}><Bookmark aria-hidden="true" />Continued from saved turn</span>
      {context.sessionTitle.trim() && <strong className={styles.title}>{context.sessionTitle}</strong>}
    </header>
    <SavedChatTurnContent record={context} />
  </section>;
}
