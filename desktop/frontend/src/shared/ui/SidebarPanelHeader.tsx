import type { ReactNode } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import { TieredHeader } from './TwoTierHeader';
import styles from './SidebarPanelHeader.module.css';
import badgeStyles from './Badge.module.css';

export function SidebarPanelTitle({ icon, title, description, count, as: Tag = 'div', id }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  count?: number;
  as?: 'div' | 'h2';
  id?: string;
}) {
  return <Tag id={id} className={styles.title}>
    {icon && <NeumorphicButton raised size="icon" className={styles.titleMark} aria-hidden="true" disabled>
      {icon}
    </NeumorphicButton>}
    <span>{title}</span>
    {count !== undefined && <span className={badgeStyles.badge}>{count}</span>}
    {description && <span className={styles.description}>{description}</span>}
  </Tag>;
}

export function SidebarPanelHeader({ icon, title, description, count, actions }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  count?: number;
  actions?: ReactNode;
}) {
  return <TieredHeader className={styles.header} primary={<>
    <SidebarPanelTitle icon={icon} title={title} description={description} count={count} />
    {actions && <div className={styles.actions}>{actions}</div>}
  </>} />;
}
