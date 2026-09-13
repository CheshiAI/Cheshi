import { MessageCircleQuestionMark } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NeumorphicButton, nonDraggableWindowRegionStyle } from '../../shared/ui';
import { useHelpLanguage } from '../../shared/useHelpLanguage';
import { getHelpArticles } from './helpArticles';
import { getHelpTranslations } from './helpTranslations';
import { HelpPanel } from './HelpPanel';
import styles from './HelpPanel.module.css';

export function HelpCenter() {
  const id = useId();
  const [language] = useHelpLanguage();
  const text = getHelpTranslations(language);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const close = () => {
    setOpen(false);
    triggerRef.current?.querySelector('button')?.focus({ preventScroll: true });
  };
  return <>
    <span ref={triggerRef} className={styles.launcher} style={nonDraggableWindowRegionStyle}>
      <NeumorphicButton raised size="icon" title={text.title} aria-label={text.title} aria-expanded={open}
        aria-controls={id} onClick={() => setOpen(value => !value)}>
        <MessageCircleQuestionMark aria-hidden="true" />
      </NeumorphicButton>
    </span>
    {typeof document !== 'undefined' && createPortal(
      <HelpPanel id={id} open={open} language={language} articles={getHelpArticles(language)} onClose={close} />, document.body,
    )}
  </>;
}
