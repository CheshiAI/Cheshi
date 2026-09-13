import { Router } from 'lucide-react';
import styles from './TerminalPaneIcon.module.css';

export function TerminalPaneIcon() {
  return <Router aria-hidden="true" className={styles.icon} strokeWidth={1.7} />;
}
