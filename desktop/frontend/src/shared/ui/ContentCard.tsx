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
  onExpandedChange?: (expanded: boolean) => void;
  /** Use a native button header for cards that perform an action instead of expanding. */
  onActivate?: () => void;
  disabled?: boolean;
  bodyClassName?: string;
}

/** Shared surface and header for result cards and their nested code panels. */
export function ContentCard({ as = 'article', title, icon, description, status, actions,
  collapsible = false, onExpandedChange, onActivate, disabled = false, descriptionWhenCollapsed = false, bodyClassName, className, children, ...props }: ContentCardProps) {
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
    {(collapsible || onActivate) && <ChevronRight className={styles.chevron} aria-hidden="true" />}
  </>;
  const body = children != null && <div className={`${styles.body} ${bodyClassName ?? ''}`}>{children}</div>;

  return <LiquidGlassPanel {...props} as={as} className={`${styles.card} ${className ?? ''}`}
    data-nested={nested ? 'true' : undefined}>
    <ContentCardContext.Provider value={true}>
      {collapsible ? <details onToggle={event => {
        if (event.target === event.currentTarget) onExpandedChange?.(event.currentTarget.open);
      }}>
        <summary className={styles.header}>{header}</summary>
        {body}
      </details> : <>
        {onActivate ? <button type="button" className={`${styles.header} ${styles.headerButton}`} disabled={disabled}
          onClick={onActivate}>{header}</button> : <header className={styles.header}>{header}</header>}
        {body}
      </>}
    </ContentCardContext.Provider>
  </LiquidGlassPanel>;
}
