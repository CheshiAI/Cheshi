import { parseWorkRequest, parseWorkResult, parseWorkReview, type WorkKind } from '../../../../shared/agent-work';
import styles from './AgentTaskResults.module.css';

export function WorkMessage({ kind, text }: { kind: WorkKind; text: string }) {
  try {
    const value: unknown = JSON.parse(text);
    if (kind === 'work_request') {
      const request = parseWorkRequest(value);
      return <div className={styles.records}>
        <p>{request.objective}</p><p>Implementation request · Original project unchanged</p>
        <details className={styles.record}><summary>Work scope · {request.files.length} snapshot files</summary>
          <ul>{request.criteria.map(c => <li key={c}>{c}</li>)}</ul>
          <p>Snapshot: {request.snapshot}</p>
          {request.previousRequestId && <p>Revision of: {request.previousRequestId}</p>}
          {request.files.map(f => <p key={f.path}>{f.path} · {request.writePaths.includes(f.path) ? 'Writable copy' : 'Read-only context'} · {f.sha256 ?? 'New file'}</p>)}
        </details>
      </div>;
    }
    if (kind === 'work_review') {
      const review = parseWorkReview(value);
      return <div><p>{review.decision === 'accepted' ? 'Proposal accepted' : 'Changes requested'} · Not applied to project</p><p>{review.feedback}</p></div>;
    }
    const result = parseWorkResult(value);
    return <div className={styles.records}>
      <p>Work · {result.status} · {result.changes.length} changed files</p><p>{result.summary}</p>
      <p>Proposed changes only. Integration and independent verification are still required.</p>
      {result.changes.map(file => <details key={file.path} className={styles.record}>
        <summary>{file.path} · {file.content === null ? 'Deleted' : file.before === null ? 'Added' : 'Modified'}</summary>
        <p>Before: {file.before ?? 'Absent'}<br />After: {file.sha256 ?? 'Absent'}</p>
        <pre>{file.content ?? 'File deleted in the isolated proposal.'}</pre>
      </details>)}
    </div>;
  } catch { return <p role="alert">Delegated work details could not be read. Inspect the saved task.</p>; }
}
