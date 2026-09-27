import { ChevronRight } from 'lucide-react';
import { createContext, useContext, type HTMLAttributes, type ReactNode } from 'react';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import styles from './ContentCard.module.css';

const ContentCardContext = createContext(false);

export function useContentCardNesting() {
  return useContext(ContentCardContext);
}

interface ContentCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'article' | 'section';
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  descriptionWhenCollapsed?: boolean;
  status?: ReactNode;
  actions?: ReactNode;
  collapsible?: boolean;
  bodyClassName?: string;
}

/** Shared surface and header for result cards and their nested code panels. */
export function ContentCard({ as = 'article', title, icon, description, status, actions,
  collapsible = false, descriptionWhenCollapsed = false, bodyClassName, className, children, ...props }: ContentCardProps) {
  const nested = useContentCardNesting();
  const header = <>
    {icon && <span className={styles.icon}>{icon}</span>}
    <span className={styles.heading}>
      <strong className={styles.title}>{title}</strong>
      {description && <span className={styles.description}
        data-collapsed-only={descriptionWhenCollapsed ? 'true' : undefined}>{description}</span>}
    </span>
    {status && <span className={styles.status}>{status}</span>}
    {actions && <span className={styles.actions}>{actions}</span>}
    {collapsible && <ChevronRight className={styles.chevron} aria-hidden="true" />}
  </>;
  const body = children != null && <div className={`${styles.body} ${bodyClassName ?? ''}`}>{children}</div>;

  return <LiquidGlassPanel {...props} as={as} className={`${styles.card} ${className ?? ''}`}
    data-nested={nested ? 'true' : undefined}>
    <ContentCardContext.Provider value={true}>
      {collapsible ? <details>
        <summary className={styles.header}>{header}</summary>
        {body}
      </details> : <>
        <header className={styles.header}>{header}</header>
        {body}
      </>}
    </ContentCardContext.Provider>
  </LiquidGlassPanel>;
}
