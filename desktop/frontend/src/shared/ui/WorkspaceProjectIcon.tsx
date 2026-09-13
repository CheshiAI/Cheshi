import styles from './WorkspaceProjectIcon.module.css';

function projectIconBackground(rootPath: string): string {
  let hash = 2166136261;
  for (const character of rootPath) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  }
  return `hsl(${hash % 360} 32% 36%)`;
}

export function WorkspaceProjectIcon({ name, rootPath }: { name: string; rootPath: string }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() || 'W';
  return <span className={styles.icon} style={{ backgroundColor: projectIconBackground(rootPath) }} aria-hidden="true">
    {initial}
  </span>;
}
