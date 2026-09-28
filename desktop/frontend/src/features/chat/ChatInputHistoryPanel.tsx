import { X } from 'lucide-react';
import { LiquidGlassPanel, NeumorphicButton, SidebarPanelHeader } from '../../shared/ui';
import type { useChatInputHistory } from './useChatInputHistory';
import styles from './ChatView.module.css';
import historyStyles from './ChatInputHistory.module.css';

export function ChatInputHistoryPanel({ history }: { history: ReturnType<typeof useChatInputHistory> }) {
  if (!history.open) return null;
  return <div ref={history.panelRef} className={styles.commandMenuAnchor} onKeyDown={history.onPanelKeyDown}>
    <LiquidGlassPanel as="section" aria-label="Input history" className={`${styles.commandMenu} ${historyStyles.panel}`}
      data-liquid-glass-backdrop="true">
      <SidebarPanelHeader title="INPUT HISTORY" actions={
        <NeumorphicButton variant="ghost" size="icon" aria-label="Close input history" title="Close input history" onClick={history.dismiss}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>
          <X aria-hidden="true" />
        </NeumorphicButton>
      } />
      <p className={styles.commandMenuSubtitle}>Select a previous question</p>
      <div id={history.listId} role="listbox" aria-label="Previous questions" className={`${styles.commandOptions} ${historyStyles.options}`}>
        {history.state.entries.map((entry, index) => <NeumorphicButton variant="ghost" type="button" role="option" tabIndex={-1}
          id={`${history.listId}-${index}`} key={`${entry.id}-${index}`} aria-selected={index === history.state.selected}
          data-active={index === history.state.selected ? 'true' : undefined}
          className={`${styles.commandOption} ${historyStyles.option}`} title={entry.text}
          onMouseEnter={() => history.highlight(index)} onMouseDown={event => event.preventDefault()}
          onClick={() => history.select(index)}>
          <span className={historyStyles.text}>{entry.text}</span>
        </NeumorphicButton>)}
      </div>
      <p className={styles.commandHelp}>↑↓ Navigate · Enter Select · Esc Close</p>
    </LiquidGlassPanel>
  </div>;
}
