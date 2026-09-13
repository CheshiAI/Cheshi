import type { ReactNode } from 'react';

import styles from './EmptyState.module.css';

interface EmptyStateProps {
  title: string;
  description: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, className }: EmptyStateProps) {
  return (
    <div className={className ? `${styles.root} ${className}` : styles.root}>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
