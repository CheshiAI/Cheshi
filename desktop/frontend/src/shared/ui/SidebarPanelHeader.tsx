import type { ReactNode } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import { TieredHeader } from './TwoTierHeader';
import styles from './SidebarPanelHeader.module.css';

export function SidebarPanelTitle({ icon, title, as: Tag = 'div', id }: {
  icon: ReactNode;
  title: string;
  as?: 'div' | 'h2';
  id?: string;
}) {
  return <Tag id={id} className={styles.title}>
    <NeumorphicButton raised size="icon" className={styles.titleMark} aria-hidden="true" disabled>
      {icon}
    </NeumorphicButton>
    <span>{title}</span>
  </Tag>;
}

export function SidebarPanelHeader({ icon, title, actions }: {
  icon: ReactNode;
  title: string;
  actions?: ReactNode;
}) {
  return <TieredHeader className={styles.header} primary={<>
    <SidebarPanelTitle icon={icon} title={title} />
    {actions && <div className={styles.actions}>{actions}</div>}
  </>} />;
}
