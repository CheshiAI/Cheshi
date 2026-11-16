import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceManagementApi } from '../../../../shared/workspace-management';
import { useHelpLanguage } from '../../shared/useHelpLanguage';
import { getHelpArticles } from './helpArticles';
import { HelpPanel } from './HelpPanel';

export function HelpCenter({ api }: { api?: Pick<WorkspaceManagementApi, 'onHelpRequested'> }) {
  const id = useId();
  const [language] = useHelpLanguage();
  const [open, setOpen] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const opened = useRef(false);
  useEffect(() => api?.onHelpRequested?.(() => {
    if (!opened.current) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    opened.current = true;
    setOpen(true);
  }), [api]);
  const close = () => {
    opened.current = false;
    setOpen(false);
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
  };
  return typeof document !== 'undefined' ? createPortal(
      <HelpPanel id={id} open={open} language={language} articles={getHelpArticles(language)} onClose={close} />, document.body,
    ) : null;
}
