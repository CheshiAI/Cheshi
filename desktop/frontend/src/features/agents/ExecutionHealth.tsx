import type { AgentExecutionHealth } from '../../../../shared/agent-execution-health';
import shared from '../../shared/agent-management/agentManagement.module.css';

export function ExecutionHealth({ health, unavailable }: { health: AgentExecutionHealth; unavailable: boolean }) {
  const engine = unavailable ? 'Status unavailable' : {
    checking: 'Checking execution engine', responding: 'Execution engine responding', unconfirmed: 'Execution engine response unconfirmed',
  }[health.engineStatus];
  const activity = { starting: 'Starting', model: 'Model activity', tool: 'Tool activity', stopping: 'Stop requested' }[health.lastActivity];
  return <div className={shared.description} aria-label="Execution health">
    <p>{engine} · {activity}</p>
    <p>Last activity: {new Date(health.lastActivityAt).toLocaleString()}</p>
    <p>Last engine response: {health.lastResponsiveAt ? new Date(health.lastResponsiveAt).toLocaleString() : 'Not confirmed yet'}</p>
    <p>No execution time limit. Engine responses confirm connectivity; quiet periods do not establish stalled work.</p>
  </div>;
}
