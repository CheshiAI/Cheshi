import { Check, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { LiquidGlassPanel } from '../../shared/ui';
import { CONFIGURATION_MENU_WIDTH, CONFIGURATION_SUBMENU_WIDTH, formatReasoningEffort } from './chatViewModel';
import type { ChatModel } from './model';
import menuStyles from './ChatView.module.css';
import styles from './TemporaryChatPanel.module.css';

type MenuView = 'root' | 'models' | 'reasoning';
interface MenuProps {
  id: string;
  trigger: RefObject<HTMLDivElement | null>;
  models: ChatModel[];
  model: string;
  effort: string;
  disabled: boolean;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  onClose: () => void;
}

export function temporaryConfigurationPosition(rect: { right: number; top: number }, viewport: { width: number; height: number }) {
  const gap = 8;
  const width = Math.min(CONFIGURATION_MENU_WIDTH, viewport.width - gap * 2);
  const left = Math.max(gap, Math.min(viewport.width - width - gap, rect.right - width));
  const leftSpace = left - gap * 2;
  const rightSpace = viewport.width - left - width - gap * 2;
  const bottom = Math.max(gap, viewport.height - rect.top + gap);
  const stacked = Math.max(leftSpace, rightSpace) < CONFIGURATION_SUBMENU_WIDTH;
  return {
    left, width, bottom,
    submenuHeight: Math.max(0, Math.min(310, viewport.height - bottom - gap - (stacked ? 94 : 0))),
    submenuSide: leftSpace >= CONFIGURATION_SUBMENU_WIDTH || leftSpace >= rightSpace ? 'left' : 'right',
    stacked,
  };
}

export function TemporaryChatConfigurationMenu({ id, trigger, models, model, effort, disabled, onModelChange, onEffortChange, onClose }: MenuProps) {
  const [view, setView] = useState<MenuView>('root');
  const [position, setPosition] = useState<ReturnType<typeof temporaryConfigurationPosition> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const changeView = (next: MenuView) => {
    // Keep keyboard focus on a surviving row when a selected option disappears.
    if (next === 'root') root.current?.querySelector<HTMLButtonElement>(`[data-configuration-view="${view}"]`)?.focus();
    setView(next);
  };
  useLayoutEffect(() => {
    const update = () => {
      if (trigger.current) setPosition(temporaryConfigurationPosition(trigger.current.getBoundingClientRect(), {
        width: window.innerWidth, height: window.innerHeight,
      }));
    };
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !trigger.current?.contains(event.target)) onClose();
    };
    update();
    const observer = new ResizeObserver(update);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('pointerdown', dismiss);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [trigger, onClose]);

  if (!position) return null;
  return <TemporaryChatConfigurationMenuContent id={id} models={models} model={model} effort={effort}
    disabled={disabled} onModelChange={onModelChange} onEffortChange={onEffortChange}
    view={view} onViewChange={changeView} position={position} menuRef={root} />;
}

export function TemporaryChatConfigurationMenuContent({
  id, models, model, effort, disabled, onModelChange, onEffortChange, view, onViewChange, position, menuRef,
}: Omit<MenuProps, 'trigger' | 'onClose'> & {
  view: MenuView;
  onViewChange: (view: MenuView) => void;
  position: ReturnType<typeof temporaryConfigurationPosition>;
  menuRef: RefObject<HTMLDivElement | null>;
}) {
  const selectedModel = models.find(option => option.model === model);
  const options = view === 'models'
    ? models.map(option => ({ value: option.model, label: option.displayName, description: option.description }))
    : (selectedModel?.supportedReasoningEfforts ?? []).map(option => ({
      value: option.effort, label: formatReasoningEffort(option.effort), description: option.description,
    }));
  return <div ref={menuRef} className={`${menuStyles.configurationPopoverAnchor} ${styles.configurationMenu}`}
    data-submenu-side={position.submenuSide} data-stacked={position.stacked || undefined}
    style={{ left: position.left, bottom: position.bottom, width: position.width }}
    onKeyDown={event => {
      if (event.key === 'Escape' && view !== 'root' && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); onViewChange('root');
      }
    }}>
    {view !== 'root' && <LiquidGlassPanel as="section" className={`${menuStyles.configurationSubmenu} ${styles.configurationSubmenu}`}
      style={{ maxHeight: position.submenuHeight }} data-liquid-glass-backdrop="true" aria-label={view === 'models' ? 'Model options' : 'Reasoning effort options'}>
      <strong className={menuStyles.configurationSubmenuTitle}>{view === 'models' ? 'Model' : 'Reasoning effort'}</strong>
      <div className={menuStyles.configurationOptions} role="listbox" aria-label={view === 'models' ? 'Model' : 'Reasoning effort'}>
        {options.map(option => {
          const selected = option.value === (view === 'models' ? model : effort);
          return <button type="button" role="option" key={option.value} aria-selected={selected}
            className={menuStyles.configurationOption} title={option.description} disabled={disabled}
            onClick={() => {
              if (view === 'models') onModelChange(option.value);
              else onEffortChange(option.value);
              onViewChange('root');
            }}>
            <span className={menuStyles.configurationOptionCopy}><strong>{option.label}</strong><span>{option.description}</span></span>
            {selected && <Check aria-hidden="true" />}
          </button>;
        })}
      </div>
    </LiquidGlassPanel>}
    <LiquidGlassPanel id={id} role="menu" aria-label="Model and reasoning effort" className={menuStyles.configurationMenu}>
      <button type="button" role="menuitem" aria-haspopup="listbox" aria-expanded={view === 'models'}
        data-configuration-view="models" className={menuStyles.configurationMenuRow}
        disabled={disabled || !models.length} onClick={() => onViewChange('models')}>
        <span>Model</span><span className={menuStyles.configurationMenuValue}>{selectedModel?.displayName ?? 'Default model'}</span>
        <ChevronRight aria-hidden="true" />
      </button>
      <button type="button" role="menuitem" aria-haspopup="listbox" aria-expanded={view === 'reasoning'}
        data-configuration-view="reasoning" className={menuStyles.configurationMenuRow}
        disabled={disabled || !selectedModel?.supportedReasoningEfforts.length} onClick={() => onViewChange('reasoning')}>
        <span>Reasoning</span><span className={menuStyles.configurationMenuValue}>{formatReasoningEffort(effort)}</span>
        <ChevronRight aria-hidden="true" />
      </button>
    </LiquidGlassPanel>
  </div>;
}
