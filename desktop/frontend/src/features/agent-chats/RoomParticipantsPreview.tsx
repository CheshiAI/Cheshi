import type { ChatMember } from '../../../../shared/agent-chats';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import styles from './ChatsRoomList.module.css';

const nameSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function shortName(name: string): string {
  const characters = Array.from(nameSegments.segment(name), part => part.segment);
  return characters.length > 4 ? `${characters.slice(0, 4).join('')}...` : name;
}

export function RoomParticipantsPreview({ members, agents }: {
  members: readonly ChatMember[];
  agents: readonly Pick<SpecialistAgent, 'id' | 'accountId' | 'avatar'>[];
}) {
  const visible = members.slice(0, 3);
  const remaining = members.slice(3);
  return <span className={styles.participants} aria-label="Participating Homies">
    {visible.map(member => <TooltipTarget key={member.id} content={member.name}>
      <span className={styles.participant} aria-label={member.name}>
        <AgentAvatar id={member.id} avatar={agents.find(agent => agent.id === member.id && agent.accountId === member.accountId)?.avatar} />
        <span className={styles.participantName}>{shortName(member.name)}</span>
      </span>
    </TooltipTarget>)}
    {remaining.length > 0 && <TooltipTarget content={remaining.map(member => member.name).join(', ')}>
      <span className={styles.moreParticipants} aria-label={`${remaining.length} more Homies`}>+{remaining.length}</span>
    </TooltipTarget>}
    {!members.length && <span>No Homies</span>}
  </span>;
}
