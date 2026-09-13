import { Check, Minus } from 'lucide-react';
import { useLayoutEffect, useRef, type InputHTMLAttributes } from 'react';

import styles from './NeumorphicCheckbox.module.css';

interface NeumorphicCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean;
}

export function NeumorphicCheckbox({
  children,
  className,
  disabled,
  indeterminate = false,
  ...props
}: NeumorphicCheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootClassName = className ? `${styles.root} ${className}` : styles.root;

  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className={rootClassName} data-disabled={disabled ? 'true' : undefined}>
      <input
        {...props}
        ref={inputRef}
        aria-checked={indeterminate ? 'mixed' : props['aria-checked']}
        className={styles.input}
        disabled={disabled}
        type="checkbox"
      />
      <span className={`${styles.checkbox} neumorphic-checkbox`} aria-hidden="true">
        {indeterminate ? <Minus /> : <Check />}
      </span>
      {children}
    </label>
  );
}
