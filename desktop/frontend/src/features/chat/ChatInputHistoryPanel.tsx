import { MessageSquareText, X } from 'lucide-react';
import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import type { useChatInputHistory } from './useChatInputHistory';
import styles from './ChatView.module.css';
import historyStyles from './ChatInputHistory.module.css';

export function ChatInputHistoryPanel({ history }: { history: ReturnType<typeof useChatInputHistory> }) {
  if (!history.open) return null;
  return <div ref={history.panelRef} onKeyDown={history.onPanelKeyDown}>
    <LiquidGlassPanel as="section" aria-label="Input history" className={`${styles.commandMenu} ${historyStyles.panel}`}
      data-liquid-glass-backdrop="true">
      <header className={`${styles.commandMenuHeader} ${historyStyles.header}`}>
        <div><strong>INPUT HISTORY</strong><span>Select a previous question</span></div>
        <NeumorphicButton raised size="icon" aria-label="Close input history" onClick={history.dismiss}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>
          <X aria-hidden="true" />
        </NeumorphicButton>
      </header>
      <div id={history.listId} role="listbox" aria-label="Previous questions" className={styles.commandOptions}>
        {history.state.entries.map((entry, index) => <button type="button" role="option" tabIndex={-1}
          id={`${history.listId}-${index}`} key={`${entry.id}-${index}`} aria-selected={index === history.state.selected}
          data-active={index === history.state.selected ? 'true' : undefined}
          className={`${styles.commandOption} ${historyStyles.option}`} title={entry.text}
          onMouseEnter={() => history.highlight(index)} onMouseDown={event => event.preventDefault()}
          onClick={() => history.select(index)}>
          <span className={`${styles.commandIcon} ${historyStyles.icon}`}><MessageSquareText aria-hidden="true" /></span>
          <span className={historyStyles.text}>{entry.text}</span>
        </button>)}
      </div>
      <p className={`${styles.commandHelp} ${historyStyles.help}`}>↑↓ Navigate · Enter Select · Esc Close</p>
    </LiquidGlassPanel>
  </div>;
}
