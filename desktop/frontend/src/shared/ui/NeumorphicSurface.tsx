import type { HTMLAttributes } from 'react';

import styles from './NeumorphicButton.module.css';

interface NeumorphicSurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'span';
  active?: boolean;
  highlightFocus?: boolean;
  inset?: boolean;
  raised?: boolean;
}

export function NeumorphicSurface({
  as: Component = 'div',
  active = false,
  highlightFocus = false,
  inset = false,
  raised = false,
  className,
  ...props
}: NeumorphicSurfaceProps) {
  const surfaceClassName = className ? `${styles.button} ${className}` : styles.button;

  return (
    <Component
      {...props}
      className={surfaceClassName}
      data-active={active ? 'true' : undefined}
      data-highlight-focus={highlightFocus ? 'true' : undefined}
      data-inset={inset ? 'true' : undefined}
      data-raised={raised ? 'true' : undefined}
    />
  );
}
