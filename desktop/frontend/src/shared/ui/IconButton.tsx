import { cloneElement, useState, type ButtonHTMLAttributes, type CSSProperties, type FocusEvent, type MouseEvent, type ReactElement, type SVGProps } from 'react';

type IconButtonSize = 'sm' | 'md' | 'lg';
type IconButtonStyle = CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag';
};

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'> {
  icon: ReactElement<SVGProps<SVGSVGElement>>;
  label: string;
  size?: IconButtonSize;
  iconColor?: string;
  hoverColor?: string;
  style?: IconButtonStyle;
}

const iconButtonSizeStyles: Record<IconButtonSize, CSSProperties> = {
  sm: { width: '32px', height: '32px' },
  md: { width: '38px', height: '38px' },
  lg: { width: '44px', height: '44px' },
};

export function IconButton({ icon, label, size = 'md', iconColor = '#a4a4a4', hoverColor = '#f1f1f1', style, onMouseEnter, onMouseLeave, onMouseDown, onMouseUp, onBlur, ...props }: IconButtonProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  const handleMouseEnter = (event: MouseEvent<HTMLButtonElement>) => {
    setIsHovered(true);
    onMouseEnter?.(event);
  };

  const handleMouseLeave = (event: MouseEvent<HTMLButtonElement>) => {
    setIsHovered(false);
    setIsPressed(false);
    onMouseLeave?.(event);
  };

  const handleMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    setIsPressed(true);
    onMouseDown?.(event);
  };

  const handleMouseUp = (event: MouseEvent<HTMLButtonElement>) => {
    setIsPressed(false);
    onMouseUp?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    setIsPressed(false);
    onBlur?.(event);
  };

  const iconStyle = {
    ...iconButtonSizeStyles[size],
    display: 'inline-grid',
    flex: '0 0 auto',
    placeItems: 'center',
    border: 0,
    borderRadius: '9px',
    backgroundColor: isHovered ? 'rgba(255, 255, 255, .08)' : 'transparent',
    color: isHovered ? hoverColor : iconColor,
    cursor: 'pointer',
    transform: isPressed ? 'scale(.96)' : 'none',
    transition: 'background-color .16s ease, color .16s ease, transform .16s ease',
    ...style,
  } satisfies CSSProperties;

  return (
    <button
      {...props}
      style={iconStyle}
      type={props.type ?? 'button'}
      aria-label={label}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onBlur={handleBlur}
    >
      {cloneElement(icon, { width: 15, height: 15, strokeWidth: icon.props.strokeWidth ?? 1.7, 'aria-hidden': true, focusable: false })}
    </button>
  );
}
