import { forwardRef, type TextareaHTMLAttributes } from 'react';

import styles from './NeumorphicTextarea.module.css';

type NeumorphicTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const NeumorphicTextarea = forwardRef<HTMLTextAreaElement, NeumorphicTextareaProps>(
  function NeumorphicTextarea({ className, ...props }, ref) {
    const textareaClassName = className
      ? `${styles.textarea} neumorphic-surface ${className}`
      : `${styles.textarea} neumorphic-surface`;

    return <textarea {...props} ref={ref} className={textareaClassName} />;
  },
);
