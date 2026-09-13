import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, ReactNode } from 'react';

import styles from './FilterTab.module.css';

interface FilterTabListProps extends ComponentPropsWithoutRef<'div'> {
  as?: 'div' | 'nav';
}

interface FilterTabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  badge?: ReactNode;
}

export function FilterTabList({ as = 'div', className, ...props }: FilterTabListProps) {
  const listClassName = className ? `${styles.list} ${className}` : styles.list;
  return as === 'nav'
    ? <nav {...props} className={listClassName} />
    : <div {...props} className={listClassName} />;
}

export function FilterTab({ active, badge, children, className, type = 'button', ...props }: FilterTabProps) {
  const buttonClassName = className ? `${styles.button} ${className}` : styles.button;
  return (
    <button
      {...props}
      className={buttonClassName}
      data-active={active ? 'true' : undefined}
      type={type}
    >
      {children}
      {badge !== undefined && <span className={styles.badge}>{badge}</span>}
    </button>
  );
}
