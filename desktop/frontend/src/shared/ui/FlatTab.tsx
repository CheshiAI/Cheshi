import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { FlatTabContextMenu, type FlatTabContextMenuTarget } from './FlatTabContextMenu';
import { NeumorphicButton } from './NeumorphicButton';
import { useFlatTabReorder, type ReorderTab } from './useFlatTabReorder';
import styles from './FlatTab.module.css';

interface FlatTabListProps extends Omit<ComponentPropsWithoutRef<'nav'>, 'role'> {
  onCloseAll: () => void;
  onReorder?: ReorderTab;
}

const TabContextMenu = createContext<((target: FlatTabContextMenuTarget) => void) | null>(null);
const TabReorderContext = createContext<ReturnType<typeof useFlatTabReorder> | null>(null);

interface FlatTabProps {
  active: boolean;
  closeLabel: string;
  label: ReactNode;
  leading?: ReactNode;
  onActivate: () => void;
  onClose: () => void;
  onCopyFullPath?: () => void;
  onOpenLocalHistory?: () => void;
  style?: CSSProperties;
  title: string;
  tabId?: string;
  trailing?: ReactNode;
}

export function FlatTabList({ className, children, onCloseAll, onReorder, ...props }: FlatTabListProps) {
  const reorder = useFlatTabReorder(onReorder);
  const [menu, setMenu] = useState<FlatTabContextMenuTarget | null>(null);
  const originRef = useRef<HTMLButtonElement | null>(null);
  const openMenu = useCallback((target: FlatTabContextMenuTarget) => {
    originRef.current = target.trigger;
    setMenu(target);
  }, []);
  const closeMenu = useCallback(() => {
    setMenu(null);
    if (originRef.current?.isConnected) originRef.current.focus({ preventScroll: true });
    originRef.current = null;
  }, []);

  useEffect(() => {
    if (menu && !menu.trigger.isConnected) closeMenu();
  }, [children, menu, closeMenu]);

  const listClassName = className ? `${styles.list} ${className}` : styles.list;
  return (
    <TabContextMenu.Provider value={openMenu}>
      <TabReorderContext.Provider value={reorder}>
        <nav {...props} className={listClassName} role="tablist">{children}</nav>
      </TabReorderContext.Provider>
      {menu && <FlatTabContextMenu target={menu} onClose={closeMenu} onCloseAll={onCloseAll} />}
    </TabContextMenu.Provider>
  );
}

export function FlatTab({
  active,
  closeLabel,
  label,
  leading,
  onActivate,
  onClose,
  onCopyFullPath,
  onOpenLocalHistory,
  style,
  title,
  tabId,
  trailing,
}: FlatTabProps) {
  const openMenu = useContext(TabContextMenu);
  const reorder = useContext(TabReorderContext);
  const canReorder = Boolean(reorder?.enabled && tabId !== undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const showMenu = (x: number, y: number) => {
    if (triggerRef.current) openMenu?.({ x, y, title, trigger: triggerRef.current, onCopyFullPath, onOpenLocalHistory });
  };
  return (
    <div
      className={styles.tab}
      data-active={active ? 'true' : undefined}
      data-drop-side={canReorder && reorder?.target?.id === tabId ? reorder?.target?.side : undefined}
      style={style}
      onDragOver={canReorder ? event => reorder?.over(event, tabId!) : undefined}
      onDragLeave={canReorder ? event => reorder?.leave(event) : undefined}
      onDrop={canReorder ? event => reorder?.drop(event, tabId!) : undefined}
      onDragEnd={canReorder ? () => reorder?.finish() : undefined}
      onContextMenu={(event) => {
        if (!openMenu) return;
        event.preventDefault();
        event.stopPropagation();
        showMenu(event.clientX, event.clientY);
      }}
    >
      <button
        ref={triggerRef}
        className={styles.trigger}
        type="button"
        role="tab"
        aria-selected={active}
        title={title}
        draggable={canReorder}
        onDragStart={canReorder ? event => reorder?.start(event, tabId!) : undefined}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (!openMenu || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          showMenu(bounds.left, bounds.bottom);
        }}
      >
        {leading}
        <span className={styles.label}>{label}</span>
        {trailing}
      </button>
      <NeumorphicButton
        raised
        className={styles.close}
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </NeumorphicButton>
    </div>
  );
}
