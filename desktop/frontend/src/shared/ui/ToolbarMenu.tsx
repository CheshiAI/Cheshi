import { Ellipsis } from 'lucide-react';
import { Fragment, useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { focusAdjacentMenuItem, useContextMenuInteractions } from './contextMenuInteractions';
import { LiquidGlassPanel } from './LiquidGlassPanel';
import { NeumorphicButton } from './NeumorphicButton';
import { beginSplitPreview } from './splitPreviewState';
import styles from './ToolbarMenu.module.css';

export interface ToolbarMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  shortcut?: string;
  separatorBefore?: boolean;
  onSelect(): void;
}

function MenuContents({ anchor, id, label, items, onClose }: {
  anchor: HTMLButtonElement;
  id: string;
  label: string;
  items: readonly ToolbarMenuItem[];
  onClose(): void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useContextMenuInteractions(menuRef, onClose);
  // Native terminal surfaces otherwise cover menus that extend beyond the header.
  useLayoutEffect(() => beginSplitPreview(), []);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const view = anchor.ownerDocument.defaultView;
    if (!menu || !view) return;
    const bounds = anchor.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.right - size.width, view.innerWidth - size.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(bounds.bottom + 8, view.innerHeight - size.height - 8))}px`;
  }, [anchor, items]);
  return createPortal(<div ref={menuRef} className={styles.menuAnchor}>
    <LiquidGlassPanel id={id} role="menu" aria-label={label} className={styles.menu}
      onKeyDown={event => {
        focusAdjacentMenuItem(event);
        if (event.key === 'Tab') onClose();
      }}>
      <div className={styles.title}>{label}</div>
      {items.map(item => <Fragment key={item.id}>
        {item.separatorBefore && <div role="separator" className={styles.separator} />}
        <NeumorphicButton size="standard" role="menuitem" aria-label={item.label} className={styles.item}
          disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>
          {item.icon}<span>{item.label}</span>{item.shortcut && <small>{item.shortcut}</small>}
        </NeumorphicButton>
      </Fragment>)}
    </LiquidGlassPanel>
  </div>, anchor.ownerDocument.body);
}

export function ToolbarMenu({ label, items, raised = false }: {
  label: string;
  items: readonly ToolbarMenuItem[];
  raised?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const close = useCallback(() => {
    setAnchor(null);
    if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, []);
  return <>
    <NeumorphicButton size="icon" raised={raised} aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={!!anchor} aria-controls={anchor ? id : undefined}
      onPointerDown={event => { if (anchor) event.stopPropagation(); }}
      onClick={event => {
        const button = event.currentTarget;
        trigger.current = button;
        setAnchor(current => current ? null : button);
      }}><Ellipsis aria-hidden="true" /></NeumorphicButton>
    {anchor && <MenuContents anchor={anchor} id={id} label={label} items={items} onClose={close} />}
  </>;
}
