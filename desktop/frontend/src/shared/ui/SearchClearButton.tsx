import { X } from 'lucide-react';
import type { ButtonHTMLAttributes, ComponentProps } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import styles from './SearchClearButton.module.css';

interface SearchClearButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> {
  'aria-label': string;
  variant?: ComponentProps<typeof NeumorphicButton>['variant'];
}

export function SearchClearButton({ className, variant, ...props }: SearchClearButtonProps) {
  const buttonClassName = className ? `${styles.button} ${className}` : styles.button;

  return (
    <NeumorphicButton {...props} variant={variant} size={variant ? 'icon' : undefined}
      raised={!variant} title={props.title ?? (variant ? props['aria-label'] : undefined)} className={buttonClassName} type="button">
      <X aria-hidden="true" />
    </NeumorphicButton>
  );
}
