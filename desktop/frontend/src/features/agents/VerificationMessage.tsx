import { parseTaskVerification, parseTaskVerificationRequest } from '../../../../shared/agent-task-inspection';
import styles from './AgentTaskResults.module.css';

/** Keep transferred file contents out of the chat transcript presentation. */
export function VerificationMessage({ kind, text }: { kind: 'verification_request' | 'verification_result'; text: string }) {
  try {
    if (kind === 'verification_request') {
      const request = parseTaskVerificationRequest(JSON.parse(text));
      return <div className={styles.records}><strong>Independent verification requested</strong>
        {request.candidate && <p>Candidate: {request.candidate.id}<br />SHA-256: {request.candidate.hash}</p>}
        <ul>{request.criteria.map((value, index) => <li key={index}>{value}</li>)}</ul>
        <details className={styles.record}><summary>Verification files · {request.artifacts.length}</summary>
          {request.artifacts.map(file => <p key={file.path}>{file.path} · {file.sha256 ?? 'Absent'}</p>)}
        </details>
      </div>;
    }
    const result = parseTaskVerification(JSON.parse(text));
    return <div className={styles.records}><strong>Independent verification result</strong>
      {result.candidate && <p>Candidate: {result.candidate.id}<br />SHA-256: {result.candidate.hash} · Not applied to project</p>}
      {result.verdicts.map((item, index) => <div key={index}><strong>{item.verdict} · {item.criterion}</strong><p>{item.reason}</p></div>)}
      <details className={styles.record}><summary>Evidence receipts · {result.evidence.length}</summary>
        {result.evidence.map(item => <div key={item.id}><p>{item.kind} · {item.detail} · Exit: {item.exitCode ?? 'Not applicable'}</p><pre>{item.output}</pre></div>)}
      </details>
    </div>;
  } catch { return <p>Verification details are unavailable.</p>; }
}
