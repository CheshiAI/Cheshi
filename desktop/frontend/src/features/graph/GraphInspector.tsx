import { Activity, MousePointer2, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { LiquidGlassPanel, NeumorphicButton, Tooltip } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { GraphSearch, GraphSettings } from './GraphSidebar';
import { GraphDetails } from './GraphWorkspace';
import { CodeGraphIndexPanel, CodeGraphReindexButton } from './CodeGraphIndexPanel';
import type { CodeGraphIndexController } from './useCodeGraphIndex';
import type { GraphController } from './useGraphController';
import styles from './GraphInspector.module.css';

const panels = [
  { id: 'explore', label: 'Explore', icon: Search },
  { id: 'selection', label: 'Selection', icon: MousePointer2 },
  { id: 'settings', label: 'Graph settings', icon: SlidersHorizontal },
  { id: 'index', label: 'CodeGraph index', icon: Activity },
] as const;

type InspectorPanel = typeof panels[number]['id'];

interface GraphInspectorProps {
  graph: GraphController;
  index: CodeGraphIndexController;
  openWorkspaceFile: (path: string, line: number | null) => void;
}

export function GraphInspector({ graph, index, openWorkspaceFile }: GraphInspectorProps) {
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
    <aside className={styles.inspector} data-open={open} aria-label="CodeGraph tools"
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
        event.preventDefault();
        closePanel();
      }}>
      <div className={styles.stage}>
        <LiquidGlassPanel
          className={styles.panel}
          aria-hidden={!open}
          inert={!open}
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
                <div className={styles.headingActions}>
                  {item.id === 'index' && <CodeGraphReindexButton index={index} />}
                  <TooltipButton
                    variant="ghost"
                    size="icon"
                    aria-label={`Close ${item.label} panel`}
                    title={`Close ${item.label} panel`}
                    onClick={closePanel}
                  >
                    <X aria-hidden="true" />
                  </TooltipButton>
                </div>
              </header>
              {item.id === 'explore' && <GraphSearch graph={graph} />}
              {item.id === 'settings' && <GraphSettings graph={graph} />}
              {item.id === 'selection' && <GraphDetails graph={graph} openWorkspaceFile={openWorkspaceFile} />}
              {item.id === 'index' && <CodeGraphIndexPanel index={index} />}
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
                variant="ghost"
                size="icon"
                active={open && panel === key}
                id={`${id}-${key}-button`}
                aria-label={label}
                aria-controls={`${id}-${key}`}
                aria-expanded={open && panel === key}
                data-index-state={key === 'index' ? (index.busy ? 'pending' : index.status.state === 'ready' ? 'ready' : 'disabled') : undefined}
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
