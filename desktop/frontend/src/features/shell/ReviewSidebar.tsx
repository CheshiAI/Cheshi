import { VerificationReviewPanel } from '../agent-chats/VerificationReview';
import type { VerificationReview } from '../agent-chats/verificationReviewModel';
import { AgentManagementViews } from './AgentManagementViews';
import { useState } from 'react';
import { FileChangesReviewPanel, type ChatActivityItem } from '../chat';
import { WorkspaceLineCommitPanel } from '../editor/WorkspaceLineCommitPanel';
import type { GitLineBlameRequest } from '../../../../shared/git-line-blame';
import styles from './ReviewSidebar.module.css';
import { useReviewSidebarResize } from './useReviewSidebarResize';
import { LocalHistoryPage } from '../editor/LocalHistoryPage';
import { useReviewSidebarFocus } from './useReviewSidebarFocus';

interface ReviewSidebarProps {
  open: boolean;
  homies?: { agentId: string | null } | null;
  verification?: VerificationReview | null;
  item: ChatActivityItem | null;
  initialPath: string | null;
  onCloseReview: () => void;
  onOpenFile?: (path: string) => void;
  lineCommit?: GitLineBlameRequest | null;
  localHistoryPath?: string | null;
  localHistoryDirty?: boolean;
}

export function ReviewSidebar({ homies = null, open, item, initialPath, lineCommit = null, localHistoryPath = null,
  localHistoryDirty = false, verification = null, onCloseReview, onOpenFile }: ReviewSidebarProps) {
  const reviewing = homies !== null || verification !== null || item !== null || lineCommit !== null || localHistoryPath !== null;
  const resizableOpen = open && (lineCommit !== null || localHistoryPath !== null);
  const resize = useReviewSidebarResize(resizableOpen, localHistoryPath !== null ? 'local history' : 'line commit');
  const focus = useReviewSidebarFocus(open && reviewing, resize.slotRef);
  const [retainedReview, setRetainedReview] = useState({ homies, item, verification, initialPath, lineCommit, localHistoryPath, active: reviewing, revision: 0 });
  // Keep the last review mounted during closing, including interrupted transitions.
  if (retainedReview.active !== reviewing
    || (reviewing && (retainedReview.homies !== homies || retainedReview.verification !== verification || retainedReview.item !== item || retainedReview.lineCommit !== lineCommit
      || retainedReview.localHistoryPath !== localHistoryPath || retainedReview.initialPath !== initialPath))) {
    setRetainedReview({
      homies: reviewing ? homies : retainedReview.homies,
      item: reviewing ? item : retainedReview.item,
      verification: reviewing ? verification : retainedReview.verification,
      initialPath: reviewing ? initialPath : retainedReview.initialPath,
      lineCommit: reviewing ? lineCommit : retainedReview.lineCommit,
      localHistoryPath: reviewing ? localHistoryPath : retainedReview.localHistoryPath,
      active: reviewing,
      // A new opening must select the requested file even if it is the same review.
      revision: retainedReview.revision + (reviewing && !retainedReview.active ? 1 : 0),
    });
  }

  return <aside ref={resize.slotRef} className={`${styles.reviewSlot} ${retainedReview.homies ? styles.homiesSlot : ''}`} data-open={open && reviewing ? 'true' : 'false'}
      data-resizable={retainedReview.lineCommit || retainedReview.localHistoryPath !== null ? 'true' : undefined}
      data-resizing={resize.resizing ? 'true' : undefined} style={resize.style}
      aria-label={retainedReview.homies ? 'Homies sidebar' : 'Review sidebar'}
      aria-hidden={focus.hidden} inert={focus.hidden} onFocusCapture={focus.onFocusCapture}>
      <div className={styles.reviewContent}>
        {resizableOpen && <div className={styles.resizer} {...resize.separatorProps} />}
        {retainedReview.homies ? <AgentManagementViews view="homies" active={open && homies !== null}
          selectionRequest={retainedReview.homies} onClose={onCloseReview} />
          : retainedReview.localHistoryPath !== null ? <LocalHistoryPage
          key={retainedReview.localHistoryPath} path={retainedReview.localHistoryPath}
          draftDirty={localHistoryDirty} onClose={onCloseReview} />
          : retainedReview.lineCommit ? <WorkspaceLineCommitPanel request={retainedReview.lineCommit} onClose={onCloseReview} />
          : retainedReview.verification ? <VerificationReviewPanel key={`${retainedReview.revision}:${retainedReview.verification.id}`} review={retainedReview.verification} onClose={onCloseReview} onOpenFile={onOpenFile} />
          : retainedReview.item && <FileChangesReviewPanel
          key={retainedReview.revision}
          item={retainedReview.item}
          initialPath={retainedReview.initialPath}
          onClose={onCloseReview}
        />}
      </div>
    </aside>;
}
