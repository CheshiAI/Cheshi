import { MousePointer2, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { LiquidGlassPanel, NeumorphicButton, Tooltip } from '../../shared/ui';
import { GraphSearch, GraphSettings } from './GraphSidebar';
import { GraphDetails } from './GraphWorkspace';
import type { GraphController } from './useGraphController';
import styles from './GraphInspector.module.css';

const panels = [
  { id: 'explore', label: 'Explore', icon: Search },
  { id: 'selection', label: 'Selection', icon: MousePointer2 },
  { id: 'settings', label: 'Graph settings', icon: SlidersHorizontal },
] as const;

type InspectorPanel = typeof panels[number]['id'];

interface GraphInspectorProps {
  graph: GraphController;
  openWorkspaceFile: (path: string, line: number | null) => void;
}

export function GraphInspector({ graph, openWorkspaceFile }: GraphInspectorProps) {
  const id = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<InspectorPanel>('explore');

  useEffect(() => {
    if (!graph.details?.node.qualifiedName) return;
    setPanel('selection');
    setOpen(true);
  }, [graph.details?.node.qualifiedName]);

  const togglePanel = (next: InspectorPanel) => {
    setOpen(!open || panel !== next);
    setPanel(next);
  };

  const closePanel = () => {
    setOpen(false);
    railRef.current?.querySelector<HTMLButtonElement>(`[aria-controls="${id}-${panel}"]`)?.focus();
  };

  return (
    <aside className={styles.inspector} data-open={open} aria-label="CodeGraph tools">
      <div className={styles.stage}>
        <LiquidGlassPanel
          className={styles.panel}
          aria-hidden={!open}
          inert={!open}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            closePanel();
          }}
        >
          {panels.map((item) => (
            <section
              key={item.id}
              id={`${id}-${item.id}`}
              className={styles.content}
              aria-labelledby={`${id}-${item.id}-button`}
              hidden={panel !== item.id}
            >
              <header className={styles.heading}>
                <span>{item.label}</span>
                <NeumorphicButton
                  raised
                  className={styles.button}
                  aria-label={`Close ${item.label} panel`}
                  onClick={closePanel}
                >
                  <X aria-hidden="true" />
                </NeumorphicButton>
              </header>
              {item.id === 'explore' && <GraphSearch graph={graph} />}
              {item.id === 'settings' && <GraphSettings graph={graph} />}
              {item.id === 'selection' && <GraphDetails graph={graph} openWorkspaceFile={openWorkspaceFile} />}
            </section>
          ))}
        </LiquidGlassPanel>
      </div>
      <div ref={railRef} className={styles.rail} role="group" aria-label="CodeGraph panels">
        {panels.map(({ id: key, label, icon: Icon }) => (
          <Tooltip key={key} content={label}>
            {(triggerProps) => (
              <NeumorphicButton
                {...triggerProps}
                raised
                active={open && panel === key}
                className={styles.button}
                id={`${id}-${key}-button`}
                aria-label={label}
                aria-controls={`${id}-${key}`}
                aria-expanded={open && panel === key}
                onClick={() => togglePanel(key)}
              >
                <Icon aria-hidden="true" />
              </NeumorphicButton>
            )}
          </Tooltip>
        ))}
      </div>
    </aside>
  );
}
