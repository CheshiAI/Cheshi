import type { ButtonHTMLAttributes } from 'react';

import styles from './NeumorphicButton.module.css';

interface NeumorphicButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  hoverWhenDisabled?: boolean;
  inset?: boolean;
  raised?: boolean;
  size?: 'standard' | 'icon';
}

export function NeumorphicButton({ active = false, hoverWhenDisabled = false, inset = false, raised = false, size, className, type = 'button', ...props }: NeumorphicButtonProps) {
  const buttonClassName = className ? `${styles.button} ${className}` : styles.button;

  return <button {...props} className={buttonClassName} data-size={size} data-active={active ? 'true' : undefined} data-hover-when-disabled={hoverWhenDisabled ? 'true' : undefined} data-inset={inset ? 'true' : undefined} data-raised={raised ? 'true' : undefined} type={type} />;
}
