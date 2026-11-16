import type { HTMLAttributes } from 'react';

import styles from './LiquidGlassPanel.module.css';
import { useRegionalBlurSurface } from './RegionalBlur';

type LiquidGlassPanelElement = 'article' | 'aside' | 'div' | 'header' | 'main' | 'section';

interface LiquidGlassPanelProps extends HTMLAttributes<HTMLElement> {
  as?: LiquidGlassPanelElement;
  'data-liquid-glass-backdrop'?: 'true' | 'false';
}

export function LiquidGlassPanel({ as: Component = 'div', className, ...props }: LiquidGlassPanelProps) {
  const panelClassName = className ? `${styles.panel} ${className}` : styles.panel;
  const ref = useRegionalBlurSurface(props.role === 'menu' || props.role === 'listbox' || props['data-liquid-glass-backdrop'] === 'true');

  return <Component {...props} ref={ref} className={panelClassName} />;
}
