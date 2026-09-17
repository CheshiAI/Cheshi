import type { AutopilotReportFormat, AutopilotState } from '../../../../shared/autopilot';
import { NeumorphicButton } from '../../shared/ui';
import styles from './AutopilotView.module.css';

export function AutopilotResearchResults({ state, exporting, onExport }: {
  state: AutopilotState; exporting: boolean; onExport(format: AutopilotReportFormat): void;
}) {
  const sources = state.sources ?? [];
  const issues = state.issues ?? [];
  return <section className={styles.research} aria-label="Research results">
    <h2>Sources · {sources.length}/{state.targetSources ?? 5}</h2>
    <p>{state.phase === 'completed' ? 'Source target reached.' : 'Collection is incomplete; available results can be exported.'}</p>
    <div className={styles.exports}>
      <NeumorphicButton size="standard" disabled={exporting || (!sources.length && !issues.length)}
        onClick={() => onExport('markdown')}>Export Markdown</NeumorphicButton>
      <NeumorphicButton size="standard" disabled={exporting || (!sources.length && !issues.length)}
        onClick={() => onExport('csv')}>Export CSV</NeumorphicButton>
    </div>
    <p>Exports save directly to Downloads/Cheshi Research.</p>
    {!sources.length && <p>Relevant passages from visited pages will appear here.</p>}
    {sources.map(source => <article className={styles.source} key={source.url}>
      <strong>{source.title || source.url}</strong>
      <span className={styles.sourceUrl}>{source.url}</span>
      <time dateTime={source.accessedAt}>Checked: {source.accessedAt}</time>
      <blockquote>{source.evidence}</blockquote>
      <small>Model confidence: {Math.round(source.confidence * 100)}% · Review evidence before use</small>
    </article>)}
    {issues.length > 0 && <><h2>Unavailable or unconfirmed</h2><ul>{issues.map((issue, index) =>
      <li key={`${index}:${issue.url}`}><span className={styles.sourceUrl}>{issue.url}</span><p>{issue.message}</p></li>)}</ul></>}
  </section>;
}
