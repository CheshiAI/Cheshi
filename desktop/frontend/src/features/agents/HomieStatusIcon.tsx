import { Activity, CircleCheck, CircleHelp, CirclePause, CircleX, Clock, KeyRound, Loader, Moon, Unplug } from 'lucide-react';
import type { ManagedAgent } from '../../../../shared/agent-management';
import { workerStatus } from '../../shared/agent-management/workerStatus';
import { TooltipButton } from '../../shared/ui/TooltipButton';

const icons = {
  Sleeping: Moon, Ready: CircleCheck, Working: Activity, 'Starting…': Loader,
  'Processing…': Loader, 'Manually stopped': CirclePause, Error: CircleX,
  'Waiting for reply': Clock, 'Sign-in required': KeyRound, 'Engine disconnected': Unplug,
  'Not assigned': Unplug, 'Agent unavailable': CircleX, 'Not running': CirclePause,
  'Status unknown': CircleHelp,
};
export type HomieStatusLabel = keyof typeof icons;

export function HomieStatusBadge({ label, name, className }: { label: HomieStatusLabel; name: string; className?: string }) {
  const Icon = icons[label];
  return <span role="img" aria-label={`${name}: ${label}`} className={className}><Icon aria-hidden="true" /></span>;
}

export function homieSnapshotStatus(workers: ManagedAgent[], unavailable: boolean): HomieStatusLabel {
  if (unavailable) return 'Engine disconnected';
  // Multiple bindings cannot identify a single current execution reliably.
  if (workers.length !== 1) return 'Status unknown';
  const labels: Record<ReturnType<typeof workerStatus>, HomieStatusLabel> = {
    sleeping: 'Sleeping', starting: 'Starting…', busy: 'Working', idle: 'Ready',
    manual: 'Manually stopped', error: 'Error', unknown: 'Status unknown',
  };
  return labels[workerStatus(workers[0]!, null, Date.now())];
}

export function HomieStatusIcon({ label, name, expanded, controls, disabled, onToggle }: {
  label: HomieStatusLabel; name: string; expanded: boolean; controls: string; disabled: boolean; onToggle(): void;
}) {
  const Icon = icons[label];
  return <TooltipButton variant="ghost" size="icon" title={label} aria-label={`Homie status: ${name}`}
    aria-expanded={expanded} aria-controls={controls} disabled={disabled} onClick={onToggle}>
    <Icon aria-hidden="true" />
  </TooltipButton>;
}
