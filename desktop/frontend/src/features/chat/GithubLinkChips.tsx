import { useMemo } from 'react';
import { NeumorphicSurface } from '../../shared/ui/NeumorphicSurface';
import { githubDraftLinks } from './chatGithubLinks';
import chatStyles from './ChatView.module.css';
import styles from './GithubLinkChips.module.css';

export function GithubLinkChips({ draft }: { draft: string }) {
  const links = useMemo(() => githubDraftLinks(draft), [draft]);
  if (links.length === 0) return null;
  return <div className={styles.tray} role="group" aria-label="GitHub links in message">
    {links.map(link => <NeumorphicSurface key={link.href} as="span" raised highlightFocus className={styles.chip}>
      <a href={link.href} target="_blank" rel="noopener noreferrer" title={link.href} aria-label={`Open GitHub: ${link.label}`}>
        <span className={`${chatStyles.externalLinkIcon} ${styles.icon}`} aria-hidden="true" />
        <span className={styles.label}>{link.label}</span>
      </a>
    </NeumorphicSurface>)}
  </div>;
}
