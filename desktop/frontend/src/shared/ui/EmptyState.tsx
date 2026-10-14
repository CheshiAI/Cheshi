import type { ReactNode } from 'react';

import styles from './EmptyState.module.css';

interface EmptyStateProps {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  variant?: 'default' | 'section';
  className?: string;
}

export function EmptyState({ title, description, icon, variant = 'default', className }: EmptyStateProps) {
  const classes = [styles.root, variant === 'section' ? styles.section : undefined, className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {icon && <span className={styles.mark} aria-hidden="true">{icon}</span>}
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
