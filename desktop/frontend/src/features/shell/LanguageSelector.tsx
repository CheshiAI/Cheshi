import { Check, Languages } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { LiquidGlassPanel } from '../../shared/ui';
import { useHelpLanguage, type HelpLanguage } from '../../shared/useHelpLanguage';
import styles from './LanguageSelector.module.css';

const options: { value: HelpLanguage; label: string }[] = [
  { value: 'en', label: 'English' }, { value: 'ko', label: '한국어' },
];

export function LanguageSelector({ className }: { className?: string }) {
  const id = useId();
  const [language, setLanguage] = useHelpLanguage();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const label = language === 'ko' ? '도움말 언어 선택' : 'Choose help language';
  const close = () => { menu.current?.hidePopover(); trigger.current?.focus(); };
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Tab') { menu.current?.hidePopover(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = items.findIndex(item => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <>
    <button ref={trigger} type="button" className={`${className ?? ''} ${styles.trigger}`}
      popoverTarget={id} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      aria-label={label} title={label}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); menu.current?.showPopover();
        }
      }}>
      <Languages aria-hidden="true" /><span>Languages</span>
    </button>
    <div ref={menu} id={id} popover="auto" className={styles.popover}
      onToggle={event => {
        const opened = event.newState === 'open';
        setOpen(opened);
        if (opened) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
      }}>
      <LiquidGlassPanel className={`liquid-glass-context-menu ${styles.menu}`} role="menu" aria-label={label} onKeyDown={navigate}>
        {options.map(option => <button key={option.value} type="button" role="menuitemradio"
          lang={option.value} aria-checked={language === option.value} className={`liquid-glass-menu-item ${styles.option}`}
          onClick={() => { setLanguage(option.value); close(); }}>
          <span>{option.label}</span>{language === option.value && <Check aria-hidden="true" />}
        </button>)}
      </LiquidGlassPanel>
    </div>
  </>;
}
