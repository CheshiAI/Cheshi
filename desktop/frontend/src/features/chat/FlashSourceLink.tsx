import { Link2 } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { FlashSourceTarget } from '../../../../shared/flash-memory';
import styles from './MessageContent.module.css';

export const FlashSourceNavigationContext = createContext<((target: FlashSourceTarget) => Promise<boolean>) | null>(null);

export function FlashSourceLink({ href, target, children }: { href: string; target: FlashSourceTarget; children: ReactNode }) {
  const open = useContext(FlashSourceNavigationContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activate = async () => {
    if (pending) return;
    setError(null);
    if (!open) { setError('이 화면에서는 대화 원문을 열 수 없습니다.'); return; }
    setPending(true);
    try {
      if (!await open(target)) setError('대화 원문을 열 수 없습니다. 잠시 후 다시 시도해 주세요.');
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
    {error && <span role="alert"> {error}</span>}
  </>;
}
