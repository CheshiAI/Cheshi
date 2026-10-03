import type { AgentTask } from '../../../../shared/agent-management';
import type { TaskEvidence, TaskMessage } from '../../../../shared/agent-task-inspection';
import { MessageContent } from '../chat/MessageContent';
import { formatRecallCost } from '../chat/HistoryRecallActivity';
import styles from './AgentTaskResults.module.css';

function Evidence({ items }: { items: TaskEvidence[] }) {
  return <div className={styles.records}>{items.map(item => <details key={item.id} className={styles.record}>
    <summary>{item.kind === 'file' ? 'File' : 'Command'} · {item.detail}</summary>
    <p>Receipt: {item.id}</p>
    {item.kind === 'command' && <p>Exit code: {item.exitCode ?? 'Unknown'} · Execution successful: {item.successful === null ? 'Unknown' : item.successful ? 'Yes' : 'No'}</p>}
    <pre>{item.output || 'No recorded output.'}</pre>
  </details>)}</div>;
}
function Exchange({ message, messages }: { message: TaskMessage; messages: TaskMessage[] }) {
  const request = message.kind === 'question' || message.kind === 'verification_request';
  const reply = request ? messages.find(m => m.questionId === message.id && (m.kind === 'reply' || m.kind === 'verification_result')) : undefined;
  const label = { question: 'Question', reply: 'Reply', verification_request: 'Verification request', verification_result: 'Verification result' }[message.kind];
  return <details className={styles.record}>
    <summary>{label} · {message.fromName} → {message.toName} · {request ? !reply ? 'Awaiting reply' : reply.delivery === 'processed' ? 'Reply processed' : 'Reply recorded' : message.delivery}</summary>
    <p>Delivery: {message.delivery} · Request: {message.questionId}</p>
    {message.verification ? <>
      {message.verification.verdicts.map((verdict, index) => <div key={index} className={styles.criterion}>
        <strong>{verdict.verdict} · {verdict.criterion}</strong><p>{verdict.reason}</p>
        <p>Evidence receipts: {verdict.evidenceIds.join(', ') || 'None'}</p>
      </div>)}
      <Evidence items={message.verification.evidence} />
    </> : message.request ? <>
      <MessageContent text={message.request.goal} />
      <ul>{message.request.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
      {message.request.artifacts.map(artifact => <div className={styles.criterion} key={artifact.path}>
        <strong>{artifact.path}</strong><p>SHA-256: {artifact.sha256}</p>
      </div>)}
    </> : <MessageContent text={message.text} />}
  </details>;
}
export function AgentTaskDetail({ task }: { task: AgentTask }) {
  const detail = task.inspection, goal = detail?.goal;
  const latest = goal?.decisions.at(-1);
  const verifications = detail?.messages.filter(m => m.kind === 'verification_request' || m.kind === 'verification_result') ?? [];
  return <>
    <dl className={styles.facts} aria-label="Task status">
      <div><dt>Status</dt><dd>{goal?.phase ?? task.status}</dd></div>
      <div><dt>Execution</dt><dd>{task.status}</dd></div>
      <div><dt>Created</dt><dd>{task.createdAt}</dd></div>
      <div><dt>Finished</dt><dd>{detail?.finishedAt ?? 'Not recorded'}</dd></div>
    </dl>
    {task.error && <div role="alert"><MessageContent text={task.error} /></div>}
    {detail?.error && <p role="alert">{detail.error}</p>}
    <section aria-label="Task goal"><h3>Goal</h3><div className={styles.markdown} aria-label="Task request"><MessageContent text={task.prompt} /></div></section>
    <section aria-label="Completion criteria"><h3>Completion criteria</h3>
      {goal?.criteria.length ? <>
        <p>Reported by the working agent. Independent verification is shown separately below.</p>
        {goal.criteria.map((criterion, index) => <div key={index} className={styles.criterion}>
          <strong>{criterion.met ? 'Reported met' : 'Not met'} · {criterion.criterion}</strong><p>{criterion.evidence || 'No evidence recorded.'}</p>
        </div>)}
      </> : <p>No completion criteria recorded for this task.</p>}
    </section>
    <section aria-label="Task progress"><h3>Progress and next action</h3>
      {goal ? <><p>Phase: {goal.phase} · Turns: {goal.turns}</p>
        {latest ? <><p>{latest.progress}</p><p>Action: {latest.action} · {latest.nextAction || 'No further action recorded.'}</p><p>{latest.reason}</p></>
          : <p>No committed decision yet.</p>}
        {goal.pending && <p>A decision is pending. It is not committed until the current turn succeeds.</p>}
        <details className={styles.record}><summary>Decision history ({goal.decisions.length})</summary>
          {goal.decisions.map((decision, index) => <div className={styles.criterion} key={index}>
            <strong>{index + 1}. {decision.action}</strong><p>{decision.progress}</p><p>{decision.reason}</p><p>{decision.nextAction}</p>
          </div>)}
        </details>
      </> : <p>No structured progress recorded for this task.</p>}
    </section>
    <section aria-label="Task collaboration"><h3>Questions and replies</h3>
      {detail?.messages.some(m => m.kind === 'question' || m.kind === 'reply') ? <div className={styles.records}>
        {detail.messages.filter(m => m.kind === 'question' || m.kind === 'reply').map(message => <Exchange key={message.id} message={message} messages={detail.messages} />)}
      </div> : <p>No recorded questions or replies.</p>}
    </section>
    <section aria-label="Independent verification"><h3>Independent verification</h3>
      {goal?.verificationRequired && <p>Required before goal completion.</p>}
      {verifications.length ? <div className={styles.records}>{verifications.map(message => <Exchange key={message.id} message={message} messages={detail?.messages ?? []} />)}</div>
        : <p>No independent verification result recorded.</p>}
    </section>
    <section aria-label="Execution evidence"><h3>File and command evidence</h3>
      <p>Recorded verification receipts; this is not a complete execution log.</p>
      {detail?.evidence.length ? <Evidence items={detail.evidence} /> : <p>No separate receipts recorded. Verification result receipts appear above.</p>}
    </section>
    <section aria-label="Task memory recall"><h3>Jev memory recall</h3>
      <p>Available entries from the worker’s latest 64 recall requests. Usage is per request and separate from the agent model.</p>
      {detail?.recall === null || !detail ? <p>Recall inspection is unavailable for this worker. Start the agent with the updated worker to enable it.</p>
        : !detail.recall.length ? <p>No retained recall entries for this task. This does not establish that no earlier lookup occurred.</p>
        : detail.recall.map(({ id, activity }) => <details key={id} className={styles.record}>
          <summary>{activity.operation} · {activity.query || 'Read source'} · {activity.status}{activity.partial ? ' · partial' : ''}</summary>
          {activity.error && <p>{activity.error}</p>}
          {activity.metrics ? <p>Jev requests: {activity.metrics.requests} · Input: {activity.metrics.inputTokens ?? 'Unknown'} · Output: {activity.metrics.outputTokens ?? 'Unknown'} · Estimated cost: {formatRecallCost(activity.metrics)}</p>
            : <p>Usage: Unknown</p>}
          {activity.metrics?.luna && <p>Luna fallback requests: {activity.metrics.luna.requests} · Input: {activity.metrics.luna.inputTokens ?? 'Unknown'} · Output: {activity.metrics.luna.outputTokens ?? 'Unknown'}</p>}
          {activity.sources.map(source => <div key={`${source.threadId}/${source.turnId}/${source.itemId}`} className={styles.criterion}>
            <strong>{source.title || 'Source'}</strong><p>Conversation: {source.threadId} · Turn: {source.turnId} · Message: {source.itemId}</p>
            <MessageContent text={source.text} />
          </div>)}
        </details>)}
    </section>
    <section aria-label="Task output"><h3>Latest output</h3><div className={styles.markdown}><MessageContent text={task.output || 'No output yet.'} /></div></section>
    {(detail?.threadId || detail?.conversation) && <details className={styles.record}><summary>Conversation references</summary>
      {detail.threadId && <p>Worker conversation: {detail.threadId}</p>}{detail.conversation && <p>Conversation key: {detail.conversation}</p>}
    </details>}
  </>;
}
