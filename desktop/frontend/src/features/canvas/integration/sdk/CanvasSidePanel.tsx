import { useId, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SlidingSidePanel } from '../../../../shared/ui/SlidingSidePanel';
import { TooltipButton } from '../../../../shared/ui/TooltipButton';
import styles from './CanvasSidePanel.module.css';

interface CanvasPanel {
  id: string;
  label: string;
  icon: LucideIcon;
  children: ReactNode;
}

export function CanvasSidePanel({ panels }: { panels: [CanvasPanel, ...CanvasPanel[]] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(panels[0].id);
  const id = useId();
  const rail = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const commitFocusedInput = () => {
    // Commit property inputs before hiding their panel on close or switch.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && content.current?.contains(focused)) focused.blur();
  };
  const close = () => {
    commitFocusedInput();
    setOpen(false);
    rail.current?.querySelector<HTMLButtonElement>(`[aria-controls="${id}-${selected}"]`)?.focus();
  };
  const toggle = (next: string) => {
    if (open && selected === next) { close(); return; }
    commitFocusedInput();
    setSelected(next);
    setOpen(true);
  };

  return <aside className={styles.side} aria-label="Canvas panels" onKeyDown={event => {
        if (!open || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
        event.preventDefault(); event.stopPropagation(); close();
      }}>
    <SlidingSidePanel open={open} stageClassName={styles.stage} className={styles.panel} aria-label="Canvas panel content">
      <div ref={content} className={styles.content}>
        {panels.map(panel => <section key={panel.id} id={`${id}-${panel.id}`} className={styles.content}
          aria-label={panel.label} hidden={selected !== panel.id} inert={!open || selected !== panel.id}
          aria-hidden={!open || selected !== panel.id}>
          {panel.children}
        </section>)}
      </div>
    </SlidingSidePanel>
    <div ref={rail} className={styles.rail} role="group" aria-label="Canvas panel controls">
      {panels.map(({ id: key, label, icon: Icon }) => <TooltipButton key={key} variant="ghost" size="icon" title={label} aria-label={label}
        aria-controls={`${id}-${key}`} aria-expanded={open && selected === key} active={open && selected === key}
        onClick={() => toggle(key)}>
        <Icon aria-hidden="true" />
      </TooltipButton>)}
    </div>
  </aside>;
}
