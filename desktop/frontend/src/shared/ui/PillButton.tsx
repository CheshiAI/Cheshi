import type { ComponentProps } from 'react';
import { NeumorphicButton } from './NeumorphicButton';
import styles from './PillDropdownButton.module.css';

export function PillButton({ className, ...props }: ComponentProps<typeof NeumorphicButton>) {
  return <NeumorphicButton raised {...props} className={`${styles.trigger}${className ? ` ${className}` : ''}`} />;
}
