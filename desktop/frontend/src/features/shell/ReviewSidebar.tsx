import { useState, type ReactNode } from 'react';
import { LiquidGlassPanel } from '../../shared/ui';
import { FileChangesReviewPanel, type ChatActivityItem } from '../chat';
import styles from './ReviewSidebar.module.css';

interface ReviewSidebarProps {
  open: boolean;
  item: ChatActivityItem | null;
  initialPath: string | null;
  onCloseReview: () => void;
  children: ReactNode;
}

export function ReviewSidebar({ open, item, initialPath, onCloseReview, children }: ReviewSidebarProps) {
  const reviewing = item !== null;
  const [retainedReview, setRetainedReview] = useState({ item, initialPath, active: reviewing, revision: 0 });
  // Keep the last review mounted during closing, including interrupted transitions.
  if (retainedReview.active !== reviewing
    || (item && (retainedReview.item !== item || retainedReview.initialPath !== initialPath))) {
    setRetainedReview({
      item: item ?? retainedReview.item,
      initialPath: item ? initialPath : retainedReview.initialPath,
      active: reviewing,
      // A new opening must select the requested file even if it is the same review.
      revision: retainedReview.revision + (reviewing && !retainedReview.active ? 1 : 0),
    });
  }

  return <>
    <LiquidGlassPanel
      as="aside"
      className="right-sidebar-column"
      data-open={open && !reviewing ? 'true' : 'false'}
      aria-hidden={!open || reviewing}
      aria-label="Right sidebar"
      inert={!open || reviewing}
    >
      {children}
    </LiquidGlassPanel>
    <aside className={styles.reviewSlot} data-open={open && reviewing ? 'true' : 'false'}
      aria-label="Review sidebar"
      aria-hidden={!open || !reviewing} inert={!open || !reviewing}>
      <div className={styles.reviewContent}>
        {retainedReview.item && <FileChangesReviewPanel
          key={retainedReview.revision}
          item={retainedReview.item}
          initialPath={retainedReview.initialPath}
          onClose={onCloseReview}
        />}
      </div>
    </aside>
  </>;
}
