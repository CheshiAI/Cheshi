import { ClipboardList } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui';
import type { ChatViewController } from './useChatViewController';
import styles from './ChatMessageQueue.module.css';

type PlanController = Pick<ChatViewController, 'chatConfiguration' | 'configurationControlsDisabled'
  | 'configurationLoading' | 'selectCollaborationMode'>;

export function ChatPlanToggle({ controller, pending = false }: { controller: PlanController; pending?: boolean }) {
  const enabled = controller.chatConfiguration?.collaborationMode === 'plan';
  return <NeumorphicButton className={`${styles.toggle} ${styles.planToggle}`} role="switch"
    aria-label="Plan mode" aria-checked={enabled}
    title={enabled ? 'Turn off Plan mode' : 'Turn on Plan mode'}
    disabled={pending || controller.configurationControlsDisabled || controller.configurationLoading || !controller.chatConfiguration}
    onClick={() => void controller.selectCollaborationMode(enabled ? 'default' : 'plan')}>
    <ClipboardList aria-hidden="true" /><span>Plan</span><span className={styles.switchTrack} aria-hidden="true" />
  </NeumorphicButton>;
}
