import { X } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import styles from './SearchClearButton.module.css';

interface SearchClearButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> {
  'aria-label': string;
}

export function SearchClearButton({ className, ...props }: SearchClearButtonProps) {
  const buttonClassName = className ? `${styles.button} ${className}` : styles.button;

  return (
    <NeumorphicButton {...props} raised className={buttonClassName} type="button">
      <X aria-hidden="true" />
    </NeumorphicButton>
  );
}
