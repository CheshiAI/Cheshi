import { FileCode, Terminal, Wrench } from 'lucide-react';
import type { TaskActivity } from '../../../../shared/agent-activity';
import { ExecutionCard } from '../../shared/ui';
import styles from './ChatsView.module.css';
import { FileChangesActivity } from '../chat/FileChangesActivity';
import type { ChatActivityItem } from '../chat/model';
import { fileChangesItem } from './fileChanges';

export function ExecutionRecord({ activity, messageId, onReview }: {
  activity: TaskActivity; messageId?: string; onReview?: (item: ChatActivityItem, path?: string) => void;
}) {
  const files = fileChangesItem(activity, messageId);
  if (files && onReview) return <div className={styles.execution}>
    <FileChangesActivity item={files} onReview={(_, path) => onReview(files, path)} />
  </div>;
  const Icon = activity.kind === 'command' ? Terminal : activity.kind === 'file' ? FileCode : Wrench;
  const title = activity.kind === 'command' ? 'Command' : activity.kind === 'file' ? 'File change' : 'Tool';
  const label = { running: 'Running', completed: 'Completed', failed: 'Failed', unknown: 'Result unknown' }[activity.status];
  return <ExecutionCard className={styles.execution} icon={<Icon aria-hidden="true" />} title={title} detail={activity.title || title}
    status={label} state={activity.status} output={activity.text} truncated={activity.truncated}
    detailLabel={activity.kind === 'command' ? 'Full command' : 'Execution details'}
    outputLabel={activity.kind === 'command' ? 'Command output' : 'Execution output'}
    emptyOutput={activity.status === 'running' ? 'Waiting for output…' : 'No output recorded yet.'}
    notice={activity.status === 'failed' ? 'Execution failed. Review the recorded output before continuing.' : undefined} />;
}
