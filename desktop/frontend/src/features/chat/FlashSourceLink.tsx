import { cheshiDesktop } from '../../cheshiDesktop';
import { Link2 } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { FlashSourceTarget } from '../../../../shared/flash-memory';
import styles from './MessageContent.module.css';

export const FlashSourceNavigationContext = createContext<((target: FlashSourceTarget) => Promise<boolean>) | null>(null);

export function FlashSourceLink({ href, target, children, readOriginal = cheshiDesktop?.flashMemory?.original }: { href: string; target: FlashSourceTarget; children: ReactNode; readOriginal?: (target: FlashSourceTarget) => Promise<string> }) {
  const open = useContext(FlashSourceNavigationContext);
  const [original, setOriginal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activate = async () => {
    if (pending) return;
    setError(null); setOriginal(null);
    if (!open && !readOriginal) { setError('이 화면에서는 대화 원문을 열 수 없습니다.'); return; }
    setPending(true);
    try {
      if (target.owner || !open) {
        if (!readOriginal) throw new Error('Original reader unavailable');
        setOriginal(await readOriginal(target));
      } else if (!await open(target)) setError('대화 원문을 열 수 없습니다. 잠시 후 다시 시도해 주세요.');
    } catch { setError('대화 원문을 열 수 없습니다. 삭제되었거나 접근할 수 없는 대화입니다.'); }
    finally { setPending(false); }
  };
  return <>
    <a href={href} className={styles.sourceLink} aria-disabled={pending || undefined}
      onClick={event => { event.preventDefault(); void activate(); }}
      onAuxClick={event => event.preventDefault()}>
      <Link2 aria-hidden="true" className={styles.sourceLinkIcon} />
      <span>{children}</span>
    </a>
    {original !== null && <span role="note" aria-label="대화 원문" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{original}</span>}
    {error && <span role="alert"> {error}</span>}
  </>;
}
