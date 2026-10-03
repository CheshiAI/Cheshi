import type { IntegrationSummary, IntegrationIssue } from '../../../../shared/agent-work';
import styles from './AgentTaskResults.module.css';

const states: Record<IntegrationSummary['status'], string> = {
  prepared: 'Integration candidate prepared', conflict: 'Integration conflict',
  stale: 'Integration needs rechecking', invalid: 'Integration candidate unavailable',
};
const reasons: Record<IntegrationIssue['kind'], string> = {
  source_changed: 'Original file changed since delegation', source_unavailable: 'Original file could not be checked',
  proposal_conflict: 'Proposals contain different changes to this file', scope_conflict: 'Proposals have incompatible paths or original snapshots',
  proposal_changed: 'Proposal or review history no longer matches', candidate_changed: 'Saved candidate is missing or its contents changed',
};
export function IntegrationDetail({ integration }: { integration: IntegrationSummary }) {
  return <section aria-label="Integration candidate" className={styles.records}>
    <strong>{states[integration.status]}</strong>
    <p>Candidate only · Not applied to project</p>
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
