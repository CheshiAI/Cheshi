import type { ChatCommandStatus } from './model';
import { statusCredits, statusPlan } from './chatStatus';
import styles from './ChatStatusPanel.module.css';

export function ChatStatusPanel({ status }: { status: ChatCommandStatus }) {
  const details = status.details;
  const limits = details?.usage?.rateLimits ?? [];
  const rows = [
    ['Codex', details?.version ? `OpenAI Codex v${details.version}` : 'Version not reported'],
    ['Server', details?.server ?? 'Not reported'],
    ['Model', status.modelDisplayName],
    ['Reasoning', status.reasoningEffort],
    ['Model provider', details?.provider ?? 'Not reported'],
    ['Directory', details?.directory ?? 'Not reported'],
    ['Permissions', details ? `${details.permissionProfile} · ${status.access}` : status.access],
    ['Approval policy', details?.approvalPolicy ?? 'Not reported'],
    ['Approval reviewer', details?.approvalsReviewer ?? 'Not reported'],
    ['AGENTS.md', details?.instructionFiles?.length ? details.instructionFiles.join('\n')
      : details?.instructionFiles ? 'None found on disk' : 'Not reported'],
    ['Account', details?.account ?? 'Not reported'],
    ['Plan', statusPlan(details?.plan ?? details?.usage?.plan)],
    ['Collaboration mode', status.collaborationMode === 'plan' ? 'Plan' : 'Default'],
    ['Session', status.threadId ?? 'Not started'],
    ['Service tier', status.serviceTierDisplayName],
    ['Response', status.responseInProgress ? 'In progress' : 'Idle'],
  ];
  return <div className={styles.panel}>
    <p className={styles.description}><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
      View current usage limits and credits</a></p>
    <dl className={styles.rows}>
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}
        {label === 'AGENTS.md' && <small>{details?.instructionNote ?? 'Loaded instruction files are not reported.'}</small>}
      </dd></div>)}
      {limits.length ? limits.map(limit => <div key={`${limit.limitId}-credits`}>
        <dt>{limits.length > 1 ? `${limit.limitName ?? limit.limitId} credits` : 'Credits'}</dt><dd>{statusCredits(limit.credits)}</dd>
      </div>) : <div><dt>Credits</dt><dd>Not reported</dd></div>}
    </dl>
    {details?.warnings.map(warning => <p className={styles.description} role="status" key={warning}>{warning}</p>)}
  </div>;
}
