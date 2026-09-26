import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';

import { NeumorphicSurface } from './NeumorphicSurface';
import styles from './NeumorphicTextField.module.css';

interface TextFieldLayoutProps {
  className?: string;
  fitPlaceholder?: boolean;
  trailingAction?: ReactNode;
}

type NeumorphicTextFieldProps = TextFieldLayoutProps & (
  | (Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> & { multiline?: false; variant?: 'standard'; ref?: Ref<HTMLInputElement> })
  | (Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'children'> & { multiline: true; variant?: never; ref?: Ref<HTMLTextAreaElement> })
);

export function NeumorphicTextField({ className, fitPlaceholder = false, trailingAction, variant, ...props }: NeumorphicTextFieldProps) {
  let control: ReactNode;
  if (props.multiline) {
    const { multiline, ref, ...nativeProps } = props;
    control = <textarea {...nativeProps} ref={ref} className={styles.control} data-multiline={multiline ? 'true' : undefined} />;
  } else {
    const { multiline, ref, ...nativeProps } = props;
    control = <input {...nativeProps} ref={ref} className={styles.control} data-multiline={multiline ? 'true' : undefined} />;
  }

  const sizeToPlaceholder = fitPlaceholder && !props.multiline;
  const surfaceProps = {
    className: className ? `${styles.field} ${className}` : styles.field,
    'data-variant': variant,
    'data-multiline': props.multiline ? 'true' : undefined,
    'data-fit-placeholder': sizeToPlaceholder ? 'true' : undefined,
    'data-trailing-action': trailingAction ? 'true' : undefined,
    'data-disabled': props.disabled ? 'true' : undefined,
  };
  const content = (
    <>
      {sizeToPlaceholder && <span className={styles.sizingText} aria-hidden="true">{props.placeholder}</span>}
      {control}
      {trailingAction}
    </>
  );
  return variant === 'standard'
    ? <span {...surfaceProps}>{content}</span>
    : <NeumorphicSurface as="span" raised highlightFocus {...surfaceProps}>{content}</NeumorphicSurface>;
}
