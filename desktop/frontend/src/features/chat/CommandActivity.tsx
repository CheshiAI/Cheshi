import { Terminal } from 'lucide-react';

import { ExecutionCard } from '../../shared/ui';
import type { ChatActivityItem } from './model';

export function CommandActivity({ item }: { item: ChatActivityItem }) {
  const running = item.status === 'inProgress';
  const status = running ? 'Running' : item.status === 'failed' ? 'Failed'
    : item.status === 'declined' ? 'Declined' : item.status === 'interrupted' ? 'Response stopped' : 'Completed';
  const emptyOutput = running ? 'Waiting for output…'
    : item.output === undefined ? 'Output is not available in this record.' : 'No output.';

  return <ExecutionCard icon={<Terminal aria-hidden="true" />} title={item.label} detail={item.detail}
    status={status} state={item.status} output={item.output} emptyOutput={emptyOutput}
    cwd={item.cwd} exitCode={item.exitCode} durationMs={item.durationMs} />;
}
