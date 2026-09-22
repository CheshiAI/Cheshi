import type { ReactNode } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import { TieredHeader } from './TwoTierHeader';
import styles from './SidebarPanelHeader.module.css';

export function SidebarPanelHeader({ icon, title, actions }: {
  icon: ReactNode;
  title: string;
  actions?: ReactNode;
}) {
  return <TieredHeader className={styles.header} primary={<>
    <div className={styles.title}>
      <NeumorphicButton raised size="icon" className={styles.titleMark} aria-hidden="true" disabled>
        {icon}
      </NeumorphicButton>
      <span>{title}</span>
    </div>
    {actions && <div className={styles.actions}>{actions}</div>}
  </>} />;
}
