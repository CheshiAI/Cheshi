import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';

import styles from './SidebarRailButton.module.css';

interface SidebarRailButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  active?: boolean;
  icon: ReactNode;
  iconSize?: 'default' | 'project';
  label: string;
}

export function SidebarRailButton({
  active = false,
  className,
  icon,
  iconSize = 'default',
  label,
  style,
  type = 'button',
  ...props
}: SidebarRailButtonProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelWidth, setLabelWidth] = useState(0);
  useLayoutEffect(() => {
    const element = labelRef.current;
    if (!element) return;
    // Measure the intrinsic label width, including its trailing padding, even while clipped.
    const measure = () => setLabelWidth(element.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [label]);
  const buttonStyle: CSSProperties & { '--rail-label-width': string } = {
    ...style,
    '--rail-label-width': `${labelWidth}px`,
  };
  const buttonClassName = className ? `${styles.button} ${className}` : styles.button;

  return <div className={styles.slot}>
    <button {...props} type={type} className={buttonClassName} style={buttonStyle}
      aria-label={props['aria-label'] ?? label} data-active={active ? 'true' : undefined}
      data-icon-size={iconSize}>
      <span className={styles.icon} aria-hidden="true">{icon}</span>
      <span ref={labelRef} className={styles.label}>{label}</span>
    </button>
  </div>;
}
