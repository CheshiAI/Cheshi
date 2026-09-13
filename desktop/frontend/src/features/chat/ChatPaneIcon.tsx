import { BotMessageSquare } from 'lucide-react';
import styles from './ChatPaneIcon.module.css';

export function ChatPaneIcon() {
  return <BotMessageSquare aria-hidden="true" className={styles.icon} strokeWidth={1.7} />;
}
