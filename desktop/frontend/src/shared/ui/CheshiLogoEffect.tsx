import { useEffect, useRef, type ReactNode } from 'react';
import { mountCheshiLogoEffect } from './cheshiLogoAnimation';
import styles from './CheshiLogoEffect.module.css';

const logo = new URL('../../../../../resources/icons/startup-logo.png', import.meta.url).href;

export function CheshiLogoEffect({ children, active = true }: { children?: ReactNode; active?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active || !hostRef.current || !canvasRef.current) return;
    return mountCheshiLogoEffect(hostRef.current, canvasRef.current, logo);
  }, [active]);
  return <div className={styles.root} ref={hostRef}>
    <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    {children && <div className={styles.content}>{children}</div>}
  </div>;
}
