import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { PillButton } from './PillButton';
import styles from './PillDropdownButton.module.css';

export function PillDropdownButton({ children, ...props }: ComponentProps<typeof PillButton>) {
  return (
    <PillButton {...props}>
      {children}
      <ChevronDown className={styles.chevron} aria-hidden="true" />
    </PillButton>
  );
}
