import type { ButtonHTMLAttributes } from 'react';

import styles from './NeumorphicButton.module.css';

interface NeumorphicButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  hoverWhenDisabled?: boolean;
  inset?: boolean;
  raised?: boolean;
  size?: 'standard' | 'icon';
  variant?: 'standard' | 'ghost';
}

export function NeumorphicButton({ active = false, hoverWhenDisabled = false, inset = false, raised = false, size, variant, className, type = 'button', ...props }: NeumorphicButtonProps) {
  const baseClassName = variant ? styles.control : styles.button;
  const buttonClassName = className ? `${baseClassName} ${className}` : baseClassName;

  return <button {...props} className={buttonClassName} data-size={size ?? (variant ? 'standard' : undefined)} data-variant={variant} data-active={active ? 'true' : undefined} data-hover-when-disabled={hoverWhenDisabled ? 'true' : undefined} data-inset={inset ? 'true' : undefined} data-raised={raised ? 'true' : undefined} type={type} />;
}
