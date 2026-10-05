import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ClipboardCheck, FileCode2, X } from 'lucide-react';
import { parseTaskVerification, parseTaskVerificationRequest } from '../../../../shared/agent-task-inspection';
import { CodePanel, ContentCard, LiquidGlassPanel, SidebarPanelHeader } from '../../shared/ui';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { VerificationMessage } from '../agents/VerificationMessage';
import { verificationSummary } from '../agents/verificationPresentation';
import type { VerificationReview } from './verificationReviewModel';
import styles from './VerificationReview.module.css';

function readReview(review: VerificationReview) {
  let request: ReturnType<typeof parseTaskVerificationRequest> | undefined;
  let result: ReturnType<typeof parseTaskVerification> | undefined;
  try { if (review.request) request = parseTaskVerificationRequest(JSON.parse(review.request.text)); } catch { /* Display an unavailable state below. */ }
  try { if (review.result) result = parseTaskVerification(JSON.parse(review.result.text)); } catch { /* Keep the valid half of the exchange visible. */ }
  return { request, result };
}
const statusLabels: Record<string, string> = { Answered: 'Reply received', 'Awaiting reply': 'Awaiting reply', Closed: 'Closed',
  Expired: 'Expired', failed: 'Delivery failed', unknown: 'Status unavailable', 'late reply · not applied': 'Late reply · not applied' };

export function VerificationCard({ review, onOpen }: { review: VerificationReview; onOpen(): void }) {
  const { request, result } = readReview(review);
  const isRequest = review.request?.id === review.id;
  const description = isRequest && request ? `${request.criteria.length} criteria · ${request.artifacts.length} files`
    : result ? verificationSummary(result) : 'Verification details are unavailable';
  return <div className={styles.message}>
    <ContentCard className={styles.card} icon={<ClipboardCheck aria-hidden="true" />} title={isRequest ? 'Verification request' : 'Verification result'}
      description={description} status={statusLabels[review.status] ?? 'Status unavailable'} onActivate={onOpen} />
  </div>;
}

export function VerificationReviewPanel({ review, onClose, onOpenFile }: {
  review: VerificationReview; onClose(): void; onOpenFile?: (path: string) => void;
}) {
  const scroll = useAutoHideScrollbars<HTMLDivElement>();
  const { request } = readReview(review);
  const isRequest = review.request?.id === review.id;
  const resultSection = <section aria-label="Verification result"><h3>Verification result</h3>
    {review.result ? <VerificationMessage kind="verification_result" text={review.result.text} showEvidence={false} />
      : <p className={styles.muted}>No verification result is linked to this request yet.</p>}
  </section>;
  return <LiquidGlassPanel as="section" className={styles.panel} data-liquid-glass-surface="side-panel" aria-label="Verification review">
    <SidebarPanelHeader icon={<ClipboardCheck aria-hidden="true" />} title="VERIFICATION"
      description={statusLabels[review.status] ?? 'Status unavailable'} actions={
        <TooltipButton variant="ghost" size="icon" title="Close verification review" aria-label="Close verification review" onClick={onClose}><X aria-hidden="true" /></TooltipButton>
      } />
    <div className={styles.content} ref={scroll}>
      {isRequest ? <>
      <section aria-label="Verification criteria"><h3>Criteria{request ? ` · ${request.criteria.length}` : ''}</h3>
        {request ? <ol className={styles.criteria}>{request.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol>
          : <p className={styles.muted}>{review.request ? 'Request details are unavailable.' : 'No linked verification request.'}</p>}
      </section>
      <section aria-label="Verification files"><h3>Files{request ? ` · ${request.artifacts.length}` : ''}</h3>
        {request?.artifacts.length ? <ul className={styles.files}>{request.artifacts.map(file => {
          const parts = file.path.split('/'), name = parts.pop() || file.path;
          return <li key={file.path} className={styles.file}>
            <FileCode2 aria-hidden="true" />
            <div className={styles.fileText}><TooltipTarget content={file.path}>
              <button type="button" className={styles.filename} disabled={!onOpenFile}
                aria-label={`Open ${file.path}`} onClick={() => onOpenFile?.(file.path)}>{name}</button>
            </TooltipTarget>
              <span className={styles.path}>{parts.join('/') || 'root'}</span>
            </div>
          </li>;
        })}</ul> : <p className={styles.muted}>No verification files recorded.</p>}
        {request?.candidate && <details className={styles.details}><summary>Verification snapshot</summary>
          <p>{request.candidate.id}</p><CodePanel variant="plain" code={request.candidate.hash} ariaLabel="Candidate hash" copyable={false} />
          {request.candidate.applicationId && <p>{request.candidate.applicationId}</p>}
        </details>}
      </section>
      </> : resultSection}
    </div>
  </LiquidGlassPanel>;
}
