import { NeumorphicButton } from '../../shared/ui';
import type { IntegrationSummary, IntegrationIssue } from '../../../../shared/agent-work';
import styles from './AgentTaskResults.module.css';

const states: Record<IntegrationSummary['status'], string> = {
  prepared: 'Integration candidate prepared', conflict: 'Integration conflict',
  stale: 'Integration needs rechecking', invalid: 'Integration candidate unavailable',
};
const applicationDescriptions: Record<NonNullable<IntegrationSummary['application']>['status'], string> = {
  applying: 'Application in progress · Check application state before continuing',
  applied: 'Applied to project · Check project verification before completion',
  interrupted: 'Application interrupted · Inspect file states before continuing',
  conflict: 'Application conflict · Review changed or unavailable original files',
  aborted: 'Application aborted · Original files match the pre-application snapshot',
};
const reasons: Record<IntegrationIssue['kind'], string> = {
  source_changed: 'Original file changed since delegation', source_unavailable: 'Original file could not be checked',
  proposal_conflict: 'Proposals contain different changes to this file', scope_conflict: 'Proposals have incompatible paths or original snapshots',
  proposal_changed: 'Proposal or review history no longer matches', candidate_changed: 'Saved candidate is missing or its contents changed',
};
export function IntegrationDetail({ integration, onInspect, inspectionDisabled = false }: {
  integration: IntegrationSummary; onInspect?(): void; inspectionDisabled?: boolean;
}) {
  return <section aria-label="Integration candidate" className={styles.records}>
    <strong>{states[integration.status]}</strong>
    <p>{integration.application ? applicationDescriptions[integration.application.status] : 'Candidate only · Not applied to project'}</p>
    {integration.application && onInspect && <NeumorphicButton variant="standard" disabled={inspectionDisabled}
      onClick={onInspect}>Inspect application</NeumorphicButton>}
    {integration.application && onInspect && inspectionDisabled && <p>Stop active work and inspect unknown executions before checking application state.</p>}
    {integration.application && <details className={styles.record}><summary>Project application · {integration.application.status}</summary>
      <p>Receipt: {integration.application.id}<br />Checked: {integration.application.updatedAt}</p>
      <p>{integration.application.lockReleased === true ? 'Application lock released.' : 'Keep worker data until application recovery is resolved.'}</p>
      <p>Recovery inspects actual files. It does not retry writes or restore over your changes.</p>
      {integration.application.files.map(file => <p key={file.path}>{file.path} · {file.phase} · {file.observed ?? 'Not inspected'}<br />Before: {file.before ?? 'Absent'}<br />After: {file.after ?? 'Absent'}</p>)}
    </details>}
    {integration.application && <p>Project verification: {integration.projectVerification?.status ?? 'Not requested'}</p>}
    {integration.projectVerification && <details className={styles.record}><summary>Project verification details</summary>
      <p>Verifier: {integration.projectVerification.agentId} · Request: {integration.projectVerification.requestId}</p>
      {integration.projectVerification.result?.verdicts.map((item, index) => <p key={index}>{item.verdict} · {item.criterion} · {item.reason}</p>)}
      {integration.projectVerification.result?.evidence.map(item => <details key={item.id} className={styles.record}>
        <summary>{item.kind} · {item.detail}</summary><p>Receipt: {item.id} · Exit: {item.exitCode ?? 'Not applicable'}</p><pre>{item.output}</pre>
      </details>)}
    </details>}
    <p>Independent verification: {integration.verification?.status ?? 'Not requested'}</p>
    {integration.verification && <details className={styles.record}><summary>Candidate verification details</summary>
      <p>Verifier: {integration.verification.agentId}<br />Request: {integration.verification.requestId}</p>
      {integration.verification.status === 'stale' && <p>These results do not establish a pass for the current candidate and original files.</p>}
      {integration.verification.result?.verdicts.map((item, index) => <div key={index}>
        <strong>{item.verdict} · {item.criterion}</strong><p>{item.reason}</p><p>Receipts: {item.evidenceIds.join(', ') || 'None'}</p>
      </div>)}
      {integration.verification.result?.evidence.map(item => <details key={item.id} className={styles.record}>
        <summary>{item.kind} · {item.detail}</summary><p>Receipt: {item.id} · Exit: {item.exitCode ?? 'Not applicable'}</p><pre>{item.output}</pre>
      </details>)}
    </details>}
    <p>{integration.requestIds.length} accepted proposals · {integration.files.length} changed files</p>
    <details className={styles.record}><summary>Integration details</summary>
      <p>Candidate: {integration.id}<br />Checked: {integration.checkedAt}</p>
      {integration.candidateHash && <p>Snapshot SHA-256: {integration.candidateHash}</p>}
      <p>Proposal requests: {integration.requestIds.join(', ')}</p>
      {integration.files.map(file => <div key={file.path}>
        <strong>{file.path} · {file.sha256 === null ? 'Deleted' : file.before === null ? 'Added' : 'Modified'}</strong>
        <p>Original: {file.before ?? 'Absent'}<br />Candidate: {file.sha256 ?? 'Absent'}</p>
      </div>)}
    </details>
    {integration.issues.map((issue, index) => <div key={`${issue.kind}/${issue.path}/${index}`}>
      <strong>{issue.path ?? 'Candidate'} · {reasons[issue.kind]}</strong>
      <details className={styles.record}><summary>Affected proposals</summary><p>{issue.requestIds.join(', ')}</p></details>
    </div>)}
  </section>;
}
