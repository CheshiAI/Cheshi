import type { AutopilotReportFormat, AutopilotState } from '../../../../shared/autopilot';
import { NeumorphicButton } from '../../shared/ui';
import styles from './AutopilotView.module.css';
import { questionStatus } from '../../../../shared/autopilot-investigation';

export function AutopilotResearchResults({ state, exporting, onExport }: {
  state: AutopilotState; exporting: boolean; onExport(format: AutopilotReportFormat): void;
}) {
  const sources = state.sources ?? [];
  const issues = state.issues ?? [];
  const investigation = state.investigation;
  const exportable = sources.length > 0 || issues.length > 0 || !!investigation;
  return <section className={styles.research} aria-label="Research results">
    <h2>{investigation ? 'Research report' : 'Sources'} · {sources.length}/{state.targetSources ?? 5}</h2>
    <p>{state.phase === 'completed' ? investigation ? 'Questions answered with collected evidence.' : 'Source target reached.'
      : 'Collection is incomplete; available results can be exported.'}</p>
    {investigation && <>
      <p>Codex · {investigation.model}</p>
      <h2>Questions and findings</h2>
      {investigation.plan.questions.map(question => {
        const answer = investigation.report?.answers.find(answer => answer.questionId === question.id);
        const evidence = investigation.assessments.filter(entry => entry.questionId === question.id);
        return <article key={question.id} className={styles.source} aria-current={investigation.activeQuestionId === question.id ? 'step' : undefined}>
          <strong>{question.question}</strong>
          <small>{answer?.status ?? questionStatus(question, investigation.assessments)}{question.requireIndependent ? ' · Independent evidence required' : ''}
            {question.requireOfficial ? ' · Official source required' : ''}</small>
          {answer ? <><p>{answer.answer}</p><strong>Source comparison</strong><p>{answer.comparison}</p>
            <strong>Limitations</strong><p>{answer.limitations}</p></> : <p>Evidence is being checked; no final answer yet.</p>}
          <div className={styles.exports}>{(answer?.sourceIds ?? evidence.map(entry => entry.sourceId)).map(id =>
            <a key={id} href={`#research-source-${id}`}>{id} · {evidence.find(entry => entry.sourceId === id)?.role}</a>)}</div>
        </article>;
      })}
    </>}
    <div className={styles.exports}>
      <NeumorphicButton size="standard" disabled={exporting || !exportable}
        onClick={() => onExport('markdown')}>Export Markdown</NeumorphicButton>
      <NeumorphicButton size="standard" disabled={exporting || !exportable}
        onClick={() => onExport('csv')}>Export CSV</NeumorphicButton>
    </div>
    <p>Exports save directly to Downloads/Cheshi Research.</p>
    {!sources.length && <p>Relevant passages from visited pages will appear here.</p>}
    {sources.map(source => <article className={styles.source} key={source.id ?? source.url} id={source.id ? `research-source-${source.id}` : undefined}>
      <strong>{source.id && `${source.id} · `}{source.title || source.url}</strong>
      <span className={styles.sourceUrl}>{source.url}</span>
      {source.section && <small>Section: {source.section}</small>}
      <time dateTime={source.accessedAt}>Checked: {source.accessedAt}</time>
      <blockquote>{source.evidence}</blockquote>
      {source.publisher && <small>Publisher group: {source.publisher}</small>}
      <small>Model confidence: {Math.round(source.confidence * 100)}% · Review evidence before use</small>
    </article>)}
    {issues.length > 0 && <><h2>Unavailable or unconfirmed</h2><ul>{issues.map((issue, index) =>
      <li key={`${index}:${issue.url}`}><span className={styles.sourceUrl}>{issue.url}</span><p>{issue.message}</p></li>)}</ul></>}
  </section>;
}
