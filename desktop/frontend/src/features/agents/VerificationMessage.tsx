import { FileCode, Terminal } from 'lucide-react';
import { parseTaskVerification, parseTaskVerificationRequest, type TaskEvidence } from '../../../../shared/agent-task-inspection';
import { CodePanel, ContentCard, ExecutionCard } from '../../shared/ui';
import { verificationSummary, verificationVerdictLabels } from './verificationPresentation';
import styles from './VerificationMessage.module.css';

function EvidenceRecord({ item }: { item: TaskEvidence }) {
  if (item.kind === 'file') return <ContentCard className={styles.card} collapsible descriptionWhenCollapsed
    icon={<FileCode aria-hidden="true" />} title="File" description={item.detail}>
    <CodePanel variant="plain" code={item.detail} ariaLabel="Evidence file" copyable={false} />
    <CodePanel variant="plain" code={item.output} ariaLabel="Recorded file hash" copyable={false} />
  </ContentCard>;
  const status = item.successful === true ? 'Completed'
    : item.successful === false || (item.exitCode !== null && item.exitCode !== 0) ? 'Failed' : 'Result unknown';
  return <ExecutionCard icon={<Terminal aria-hidden="true" />} title="Command" detail={item.detail}
    status={status} output={item.output} exitCode={item.exitCode ?? undefined} />;
}

/** Present verification records in the transcript without exposing serialized peer context. */
export function VerificationMessage({ kind, text, showEvidence = true }: {
  kind: 'verification_request' | 'verification_result'; text: string; showEvidence?: boolean;
}) {
  try {
    if (kind === 'verification_request') {
      const request = parseTaskVerificationRequest(JSON.parse(text));
      return <div className={styles.message}>
        <p>{request.candidate?.applicationId ? 'Applied project verification requested' : 'Independent verification requested'}</p>
        {request.candidate && <p>Candidate: {request.candidate.id}<br />SHA-256: {request.candidate.hash}{request.candidate.applicationId && <><br />Application: {request.candidate.applicationId}</>}</p>}
        <ul className={styles.criteria}>{request.criteria.map((value, index) => <li key={index}>{value}</li>)}</ul>
        <ContentCard className={styles.card} collapsible title={`Verification files · ${request.artifacts.length}`}>
          <div className={styles.files}>{request.artifacts.map(file => <div key={file.path}>
            <p>{file.path}</p><CodePanel variant="plain" code={file.sha256 ?? 'Absent'} ariaLabel="Requested file hash" copyable={false} />
          </div>)}</div>
        </ContentCard>
      </div>;
    }
    const result = parseTaskVerification(JSON.parse(text));
    return <div className={styles.message}>
      <div className={styles.heading}><span>Independent verification result</span><span className={styles.summary}>{verificationSummary(result)}</span></div>
      {result.candidate && <details><summary>Verification snapshot</summary><p>Candidate: {result.candidate.id}<br />SHA-256: {result.candidate.hash} · {result.candidate.applicationId ? `Project application: ${result.candidate.applicationId}` : 'Not applied to project'}</p></details>}
      <ul className={styles.criteria}>{result.verdicts.map((item, index) => <li className={styles.criterion} key={index}>
        <div className={styles.criterionHeader}><span className={styles.verdict} data-verdict={item.verdict}>{verificationVerdictLabels[item.verdict]}</span><span>{item.criterion}</span></div>
        <p>{item.reason}</p>
      </li>)}</ul>
      {showEvidence && <ContentCard className={styles.card} collapsible title={`Evidence receipts · ${result.evidence.length}`}>
        {result.evidence.length ? result.evidence.map(item => <EvidenceRecord key={item.id} item={item} />) : <p>No evidence recorded.</p>}
      </ContentCard>}
    </div>;
  } catch { return <p className={styles.message}>Verification details are unavailable.</p>; }
}
