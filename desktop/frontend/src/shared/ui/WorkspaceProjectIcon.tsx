import styles from './WorkspaceProjectIcon.module.css';

export function WorkspaceProjectIcon({ name, color }: { name: string; color?: string }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() || 'W';
  return <span className={styles.icon} style={{ backgroundColor: color ?? 'var(--control-surface)' }} aria-hidden="true">
    {initial}
  </span>;
}
