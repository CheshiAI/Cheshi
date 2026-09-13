import type { HTMLAttributes, ReactNode } from 'react';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import styles from './TwoTierHeader.module.css';

interface TieredHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  primary: ReactNode;
  secondary?: ReactNode;
  tertiary?: ReactNode;
  primaryClassName?: string;
  secondaryClassName?: string;
  tertiaryClassName?: string;
}

export function TieredHeader({
  className,
  primary,
  secondary,
  tertiary,
  primaryClassName,
  secondaryClassName,
  tertiaryClassName,
  ...props
}: TieredHeaderProps) {
  const hasSecondary = secondary !== undefined && secondary !== null;
  const hasTertiary = tertiary !== undefined && tertiary !== null;
  const tierCount = 1 + Number(hasSecondary) + Number(hasTertiary);
  const headerClassName = className ? `${styles.header} ${className}` : styles.header;
  const primaryClasses = primaryClassName ? `${styles.primary} ${primaryClassName}` : styles.primary;
  const secondaryClasses = secondaryClassName ? `${styles.secondary} ${secondaryClassName}` : styles.secondary;
  const tertiaryClasses = tertiaryClassName ? `${styles.tertiary} ${tertiaryClassName}` : styles.tertiary;

  return (
    <LiquidGlassPanel
      {...props}
      as="header"
      className={headerClassName}
      data-liquid-glass-surface="side-panel"
      data-tier-count={tierCount}
    >
      <div className={primaryClasses}>{primary}</div>
      {hasSecondary && <div className={secondaryClasses}>{secondary}</div>}
      {hasTertiary && <div className={tertiaryClasses}>{tertiary}</div>}
    </LiquidGlassPanel>
  );
}

export const TwoTierHeader = TieredHeader;
