import type { HTMLAttributes, ReactNode } from 'react';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import styles from './SlidingSidePanel.module.css';

interface SlidingSidePanelProps extends Omit<HTMLAttributes<HTMLElement>, 'aria-hidden' | 'children'> {
  open: boolean;
  anchor?: 'start' | 'end';
  stageClassName?: string;
  children: ReactNode;
}

export function SlidingSidePanel({ open, anchor = 'start', stageClassName, className, inert, children, ...props }: SlidingSidePanelProps) {
  const stageClasses = stageClassName ? `${styles.stage} ${stageClassName}` : styles.stage;
  const panelClasses = className ? `${styles.panel} ${className}` : styles.panel;

  return <div className={stageClasses} data-open={open ? 'true' : 'false'} data-anchor={anchor}>
    <LiquidGlassPanel {...props} className={panelClasses} aria-hidden={!open || undefined} inert={Boolean(inert) || !open}>
      {children}
    </LiquidGlassPanel>
  </div>;
}
