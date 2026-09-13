import { forwardRef, type InputHTMLAttributes } from 'react';

import styles from './NeumorphicInput.module.css';

type NeumorphicInputProps = InputHTMLAttributes<HTMLInputElement>;

export const NeumorphicInput = forwardRef<HTMLInputElement, NeumorphicInputProps>(function NeumorphicInput(
  { className, ...props },
  ref,
) {
  const inputClassName = className
    ? `${styles.input} neumorphic-surface ${className}`
    : `${styles.input} neumorphic-surface`;

  return <input {...props} ref={ref} className={inputClassName} />;
});
