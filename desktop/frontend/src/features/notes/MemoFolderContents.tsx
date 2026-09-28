import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import styles from './AppleNotes.module.css';

const SLIDE_DURATION_MS = 200;
const slideStyle = { '--memo-folder-duration': `${SLIDE_DURATION_MS}ms` } as CSSProperties;

export function MemoFolderContents({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  const [present, setPresent] = useState(expanded);
  const retainedContent = useRef(children);

  useLayoutEffect(() => {
    if (expanded) {
      retainedContent.current = children;
      setPresent(true);
    }
  }, [expanded, children]);

  useEffect(() => {
    if (expanded || !present) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false);
      return;
    }
    // Hidden panes may not dispatch transitionend; still release their content.
    const timer = window.setTimeout(() => setPresent(false), SLIDE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [expanded, present]);

  if (!expanded && !present) return null;
  return <div className={styles.folderReveal} style={slideStyle} data-expanded={expanded}
    inert={!expanded} aria-hidden={!expanded}
    onTransitionEnd={event => {
      if (!expanded && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') {
        setPresent(false);
      }
    }}>
    {expanded ? children : retainedContent.current}
  </div>;
}
