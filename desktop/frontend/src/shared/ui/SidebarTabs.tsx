import { useId, type CSSProperties, type ReactNode } from 'react';

import { FilterTab, FilterTabList } from './FilterTab';
import { useScrollSnapTabs } from './useScrollSnapTabs';
import { useSidebarTabStrip } from './useSidebarTabStrip';
import styles from './SidebarTabs.module.css';

export interface SidebarTab {
  id: string;
  label: string;
  content: ReactNode;
}

export function SidebarTabs({ tabs, activeId, onSelect }: {
  tabs: readonly SidebarTab[];
  activeId: string;
  onSelect(id: string): void;
}) {
  const id = useId();
  const activeIndex = Math.max(0, tabs.findIndex(tab => tab.id === activeId));
  const visibleCount = Math.min(3, tabs.length);
  const selectScrolledTab = (index: number) => {
    const next = tabs[index];
    if (!next) return;
    const viewport = viewportRef.current;
    const document = viewport?.ownerDocument;
    if (document && (viewport?.contains(document.activeElement) || stripRef.current?.contains(document.activeElement))) {
      document.getElementById(`${id}-tab-${next.id}`)?.focus({ preventScroll: true });
    }
    onSelect(next.id);
  };
  const viewportRef = useScrollSnapTabs(activeIndex, selectScrolledTab);
  const stripRef = useSidebarTabStrip(activeIndex, tabs.length, visibleCount, selectScrolledTab);
  return <div className={styles.root} style={{ '--sidebar-tab-count': tabs.length, '--sidebar-visible-tabs': visibleCount } as CSSProperties}>
    <div ref={stripRef} className={styles.tabViewport}>
    <FilterTabList className={styles.tabs} role="tablist" aria-label="Sidebar panels">
      {tabs.map((tab, index) => <FilterTab key={tab.id} className={styles.tab}
        id={`${id}-tab-${tab.id}`} role="tab" active={index === activeIndex}
        aria-selected={index === activeIndex} aria-controls={`${id}-panel-${tab.id}`}
        tabIndex={index === activeIndex ? 0 : -1} onClick={event => {
          event.currentTarget.focus({ preventScroll: true });
          onSelect(tab.id);
        }}
        onKeyDown={event => {
          let next: number;
          switch (event.key) {
            case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
            case 'ArrowRight': next = (index + 1) % tabs.length; break;
            case 'Home': next = 0; break;
            case 'End': next = tabs.length - 1; break;
            default: return;
          }
          event.preventDefault();
          event.stopPropagation();
          onSelect(tabs[next]!.id);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
        }}>{tab.label}</FilterTab>)}
    </FilterTabList>
    </div>
    <div ref={viewportRef} className={styles.panels}>
      <div className={styles.track}>
        {tabs.map((tab, index) => <div key={tab.id} id={`${id}-panel-${tab.id}`}
          className={styles.panel} role="tabpanel" aria-labelledby={`${id}-tab-${tab.id}`}
          aria-hidden={index !== activeIndex} inert={index !== activeIndex} tabIndex={0}>
          {tab.content}
        </div>)}
      </div>
    </div>
  </div>;
}
