import type { ButtonHTMLAttributes, ReactNode } from 'react';

import styles from './SidebarRailButton.module.css';

interface SidebarRailButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  active?: boolean;
  icon: ReactNode;
  iconSize?: 'default' | 'project';
  label: string;
}

export function SidebarRailButton({
  active = false,
  className,
  icon,
  iconSize = 'default',
  label,
  type = 'button',
  ...props
}: SidebarRailButtonProps) {
  const buttonClassName = className ? `${styles.button} ${className}` : styles.button;

  return <div className={styles.slot}>
    <button {...props} type={type} className={buttonClassName}
      aria-label={props['aria-label'] ?? label} data-active={active ? 'true' : undefined}
      data-icon-size={iconSize}>
      <span className={styles.icon} aria-hidden="true">{icon}</span>
      <span className={styles.label}>{label}</span>
    </button>
  </div>;
}
