import { ArrowLeft } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentTask } from '../../../../shared/agent-management';
import { NeumorphicButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { formatSessionElapsedTime, useChatSessionClock } from '../chat/chatSessionTime';
import { MessageContent } from '../chat/MessageContent';
import common from '../../shared/agent-management/agentManagement.module.css';
import styles from './AgentTaskResults.module.css';

export function AgentTaskResults({ tasks, loading, running }: {
  tasks: readonly AgentTask[]; loading: boolean; running: boolean;
}) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const lastOpened = useRef<string | null>(null);
  const scrollbar = useAutoHideScrollbars<HTMLElement>();
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const task = tasks.find(item => item.id === taskId);
  const now = useChatSessionClock(!task && tasks.length > 0);

  useEffect(() => {
    if (!loading && taskId && !task) setTaskId(null);
  }, [loading, taskId, task]);
  useLayoutEffect(() => {
    if (task) { content.current?.scrollTo({ top: 0 }); content.current?.focus({ preventScroll: true }); }
    else if (lastOpened.current) {
      [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-task-id]') ?? [])]
        .find(button => button.dataset.taskId === lastOpened.current)?.focus({ preventScroll: true });
    }
  }, [task?.id, content, list]);

  return <section ref={scrollbar} className={styles.root} aria-label="Task results">
    <div className={styles.header}>
      {task && <TooltipButton variant="ghost" size="icon" aria-label="Back to task list" title="Back to task list"
        onClick={() => setTaskId(null)}><ArrowLeft aria-hidden="true" /></TooltipButton>}
      <TooltipTarget content={task?.id}><h2 className={`${common.sectionTitle} ${styles.heading}`}>
        {task?.id ?? 'RECENT TASK RESULTS'}
      </h2></TooltipTarget>
    </div>
    <div ref={list} className={styles.list} hidden={Boolean(task)} aria-label="Task result list">
      {tasks.map(item => {
        const title = item.prompt.trim().split(/\r?\n/, 1)[0] || item.id;
        const elapsed = formatSessionElapsedTime(Date.parse(item.createdAt) / 1000, now);
        return <NeumorphicButton key={item.id} variant="ghost" className={styles.task} data-task-id={item.id}
          aria-label={`Open task: ${item.id}`} aria-current={item.id === lastOpened.current ? 'page' : undefined}
          onClick={() => { lastOpened.current = item.id; setTaskId(item.id); }}>
          <TooltipTarget content={title}><span className={styles.title}>{title}</span></TooltipTarget>
          <span className={styles.metadata}>
            <TooltipTarget content={item.id}><span className={styles.id}>{item.id}</span></TooltipTarget>
            <span className={styles.status}>{item.status}</span>
            <span className={styles.time} aria-label={elapsed === '—' ? 'Created time unavailable' : `Created ${elapsed} ago`}>{elapsed}</span>
          </span>
        </NeumorphicButton>;
      })}
      {tasks.length === 0 && <p className={styles.empty}>{loading ? 'Loading task results…' : running
        ? 'No task results available.' : 'Start the worker to read its stored task results.'}</p>}
    </div>
    {task && <div ref={content} className={styles.content} aria-label="Task result content" tabIndex={-1}>
      <p className={common.description}>{task.status} · {task.createdAt}</p>
      <div className={styles.markdown} aria-label="Task request"><MessageContent text={task.prompt} /></div>
      <div className={styles.markdown} aria-label="Task output">
        <MessageContent text={task.output || task.error || 'No output yet.'} />
      </div>
    </div>}
  </section>;
}
