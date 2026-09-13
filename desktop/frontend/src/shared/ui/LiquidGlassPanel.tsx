import type { HTMLAttributes } from 'react';

import styles from './LiquidGlassPanel.module.css';

type LiquidGlassPanelElement = 'article' | 'aside' | 'div' | 'header' | 'main' | 'section';

interface LiquidGlassPanelProps extends HTMLAttributes<HTMLElement> {
  as?: LiquidGlassPanelElement;
}

export function LiquidGlassPanel({ as: Component = 'div', className, ...props }: LiquidGlassPanelProps) {
  const panelClassName = className ? `${styles.panel} ${className}` : styles.panel;

  return <Component {...props} className={panelClassName} />;
}
