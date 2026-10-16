import { CircleCheck, CircleAlert, CircleX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassPanel } from './LiquidGlassPanel';
import { TooltipButton } from './TooltipButton';
import { RegionalBlur } from './RegionalBlur';
import styles from './StatusToast.module.css';

import type { StatusToastMessage } from '../../../../shared/status-toast';
import type { WorkspaceHostApi } from '../../../../shared/workspace-host';
export type { StatusToastMessage } from '../../../../shared/status-toast';

export interface StatusToastProps {
  message: StatusToastMessage;
  onDismiss: () => void;
}

export function StatusToast(props: StatusToastProps) {
  return typeof window.workspaceHost?.showStatusToast === 'function'
    ? <HostStatusToast {...props} api={window.workspaceHost} />
    : <LocalStatusToast {...props} />;
}

function HostStatusToast({ message, onDismiss, api }: StatusToastProps & { api: WorkspaceHostApi }) {
  const [fallback, setFallback] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    let active = true;
    setFallback(false);
    void api.showStatusToast(message).then(delivered => {
      if (!active) return;
      if (delivered === true) dismiss.current();
      else setFallback(true);
    }).catch(() => { if (active) setFallback(true); });
    return () => { active = false; };
  }, [api, message]);
  return fallback ? <LocalStatusToast message={message} onDismiss={onDismiss} /> : null;
}

function LocalStatusToast({ message, onDismiss }: StatusToastProps) {
  const sourceRef = useRef(document.getElementById('app'));
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(), 10_000);
    return () => window.clearTimeout(timer);
  }, [message.id]);
  const Icon = { success: CircleCheck, warning: CircleAlert, error: CircleX }[message.variant];

  return createPortal(
    <RegionalBlur sourceRef={sourceRef} sourceMode="replace">
      <div className={styles.anchor}>
        <LiquidGlassPanel as="aside" className={styles.card} data-liquid-glass-backdrop="true" data-variant={message.variant}>
          <span className={styles.icon} aria-hidden="true"><Icon /></span>
          <div className={styles.content} role={message.variant === 'error' ? 'alert' : 'status'} aria-atomic="true">
            <strong className={styles.title}>{message.title}</strong>
            <p className={styles.description}>{message.description}</p>
          </div>
          <TooltipButton variant="ghost" size="icon" aria-label="Close notification" title="Close notification" onClick={onDismiss}>
            <X aria-hidden="true" />
          </TooltipButton>
        </LiquidGlassPanel>
      </div>
    </RegionalBlur>,
    document.body,
  );
}
