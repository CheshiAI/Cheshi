import { Check, ChevronDown } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import { NeumorphicButton } from './NeumorphicButton';
import { PillDropdownButton } from './PillDropdownButton';
import styles from './LiquidGlassSelect.module.css';

export interface LiquidGlassSelectOption<Value extends string> {
  label: string;
  value: Value;
  disabled?: boolean;
  description?: string;
}

interface LiquidGlassSelectProps<Value extends string> {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  placeholder?: string;
  menuLabel?: string;
  menuPlacement?: 'auto' | 'left';
  menuWidth?: number;
  onChange: (value: Value) => void;
  options: readonly LiquidGlassSelectOption<Value>[];
  triggerAppearance?: 'flat' | 'raised' | 'pill';
  value: Value;
}

type MenuPosition = Pick<CSSProperties, 'left' | 'top' | 'width'>;

const VIEWPORT_GAP = 8;
const MENU_GAP = 8;
const MENU_ITEM_HEIGHT = 36;
const MENU_ITEM_GAP = 4;
const MENU_PADDING = 16;
const MENU_BORDER_WIDTH = 1;
const DEFAULT_MENU_WIDTH = 160;

function focusAdjacentOption(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
  const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')];
  if (options.length === 0) return;
  event.preventDefault();
  const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'Home') {
    options[0]?.focus();
    return;
  }
  if (event.key === 'End') {
    options.at(-1)?.focus();
    return;
  }
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const nextIndex = currentIndex < 0
    ? direction > 0 ? 0 : options.length - 1
    : (currentIndex + direction + options.length) % options.length;
  options[nextIndex]?.focus();
}

export function LiquidGlassSelect<Value extends string>({
  ariaLabel,
  className,
  disabled = false,
  busy = false,
  title,
  placeholder,
  menuLabel = ariaLabel,
  menuPlacement = 'auto',
  menuWidth,
  onChange,
  options,
  triggerAppearance = 'raised',
  value,
}: LiquidGlassSelectProps<Value>) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const generatedId = useId().replaceAll(':', '');
  const menuId = `liquid-glass-select-${generatedId}`;
  const selectedOption = options.find((option) => option.value === value) ?? (placeholder ? undefined : options[0]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    const updateMenuPosition = (): void => {
      const trigger = rootRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(
        menuWidth ?? Math.max(rect.width, DEFAULT_MENU_WIDTH),
        window.innerWidth - VIEWPORT_GAP * 2,
      );
      const estimatedHeight = options.length * MENU_ITEM_HEIGHT
        + Math.max(0, options.length - 1) * MENU_ITEM_GAP
        + MENU_PADDING + MENU_BORDER_WIDTH * 2;
      if (menuPlacement === 'left') {
        const left = Math.max(VIEWPORT_GAP, rect.left - width - MENU_GAP);
        const top = Math.min(
          window.innerHeight - estimatedHeight - VIEWPORT_GAP,
          Math.max(VIEWPORT_GAP, rect.top + rect.height / 2 - estimatedHeight / 2),
        );
        setMenuPosition({ left, top, width });
        return;
      }

      const left = Math.min(
        window.innerWidth - width - VIEWPORT_GAP,
        Math.max(VIEWPORT_GAP, rect.right - width),
      );
      const top = window.innerHeight - rect.bottom >= estimatedHeight + MENU_GAP + VIEWPORT_GAP
        ? rect.bottom + MENU_GAP
        : Math.max(VIEWPORT_GAP, rect.top - estimatedHeight - MENU_GAP);
      setMenuPosition({ left, top, width });
    };

    updateMenuPosition();
    const focusFrame = requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
      (selected ?? menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'))?.focus();
    });
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [menuPlacement, menuWidth, open, options.length]);

  const rootClassName = className ? `${styles.root} ${className}` : styles.root;
  const triggerClassName = triggerAppearance === 'raised'
    ? `neumorphic-surface ${styles.trigger}`
    : styles.trigger;
  const Trigger = triggerAppearance === 'pill' ? PillDropdownButton : NeumorphicButton;

  return (
    <div className={rootClassName} ref={rootRef}>
      <Trigger
        raised={triggerAppearance !== 'flat'}
        className={triggerAppearance === 'pill' ? undefined : triggerClassName}
        data-appearance={triggerAppearance}
        aria-busy={busy}
        title={title ?? selectedOption?.description}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span>{selectedOption?.label ?? placeholder ?? value}</span>
        {triggerAppearance !== 'pill' && <ChevronDown className={styles.chevron} aria-hidden="true" />}
      </Trigger>

      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className={styles.popoverAnchor}
          data-placement={menuPlacement}
          style={menuPosition}
        >
          <LiquidGlassPanel
            id={menuId}
            className={styles.popover}
            data-liquid-glass-surface="side-panel"
            role="menu"
            aria-label={menuLabel}
            onKeyDown={focusAdjacentOption}
          >
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  className={`liquid-glass-menu-item ${styles.option}`}
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={option.disabled}
                  title={option.description}
                  onClick={() => {
                    setOpen(false);
                    rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
                    onChange(option.value);
                  }}
                >
                  <span>{option.label}</span>
                  {selected && <Check aria-hidden="true" />}
                </button>
              );
            })}
          </LiquidGlassPanel>
        </div>,
        document.body,
      )}
    </div>
  );
}
