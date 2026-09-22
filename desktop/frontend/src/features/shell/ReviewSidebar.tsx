import { useState } from 'react';
import { FileChangesReviewPanel, type ChatActivityItem } from '../chat';
import { WorkspaceLineCommitPanel } from '../editor/WorkspaceLineCommitPanel';
import type { GitLineBlameRequest } from '../../../../shared/git-line-blame';
import styles from './ReviewSidebar.module.css';
import { useReviewSidebarResize } from './useReviewSidebarResize';
import { LocalHistoryPage } from '../editor/LocalHistoryPage';

interface ReviewSidebarProps {
  open: boolean;
  item: ChatActivityItem | null;
  initialPath: string | null;
  onCloseReview: () => void;
  lineCommit?: GitLineBlameRequest | null;
  localHistoryPath?: string | null;
  localHistoryDirty?: boolean;
}

export function ReviewSidebar({ open, item, initialPath, lineCommit = null, localHistoryPath = null,
  localHistoryDirty = false, onCloseReview }: ReviewSidebarProps) {
  const reviewing = item !== null || lineCommit !== null || localHistoryPath !== null;
  const resizableOpen = open && (lineCommit !== null || localHistoryPath !== null);
  const resize = useReviewSidebarResize(resizableOpen, localHistoryPath !== null ? 'local history' : 'line commit');
  const [retainedReview, setRetainedReview] = useState({ item, initialPath, lineCommit, localHistoryPath, active: reviewing, revision: 0 });
  // Keep the last review mounted during closing, including interrupted transitions.
  if (retainedReview.active !== reviewing
    || (reviewing && (retainedReview.item !== item || retainedReview.lineCommit !== lineCommit
      || retainedReview.localHistoryPath !== localHistoryPath || retainedReview.initialPath !== initialPath))) {
    setRetainedReview({
      item: reviewing ? item : retainedReview.item,
      initialPath: reviewing ? initialPath : retainedReview.initialPath,
      lineCommit: reviewing ? lineCommit : retainedReview.lineCommit,
      localHistoryPath: reviewing ? localHistoryPath : retainedReview.localHistoryPath,
      active: reviewing,
      // A new opening must select the requested file even if it is the same review.
      revision: retainedReview.revision + (reviewing && !retainedReview.active ? 1 : 0),
    });
  }

  return <aside ref={resize.slotRef} className={styles.reviewSlot} data-open={open && reviewing ? 'true' : 'false'}
      data-resizable={retainedReview.lineCommit || retainedReview.localHistoryPath !== null ? 'true' : undefined}
      data-resizing={resize.resizing ? 'true' : undefined} style={resize.style}
      aria-label="Review sidebar"
      aria-hidden={!open || !reviewing} inert={!open || !reviewing}>
      <div className={styles.reviewContent}>
        {resizableOpen && <div className={styles.resizer} {...resize.separatorProps} />}
        {retainedReview.localHistoryPath !== null ? <LocalHistoryPage
          key={retainedReview.localHistoryPath} path={retainedReview.localHistoryPath}
          draftDirty={localHistoryDirty} onClose={onCloseReview} />
          : retainedReview.lineCommit ? <WorkspaceLineCommitPanel request={retainedReview.lineCommit} onClose={onCloseReview} />
          : retainedReview.item && <FileChangesReviewPanel
          key={retainedReview.revision}
          item={retainedReview.item}
          initialPath={retainedReview.initialPath}
          onClose={onCloseReview}
        />}
      </div>
    </aside>;
}
