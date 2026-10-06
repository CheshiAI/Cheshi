import { ProjectEnvironmentSetup } from './ProjectEnvironmentSetup';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { ChatsRequest, RoomMessage } from '../../../../shared/agent-chats';
import { ContentCard } from '../../shared/ui/ContentCard';
import { NeumorphicButton } from '../../shared/ui';
import styles from './ChatsView.module.css';

export function PermissionRequestCard({ message, workspace, mutate }: {
  message: RoomMessage; workspace: string; mutate(request: ChatsRequest): Promise<unknown>;
}) {
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const request = message.permissionRequest!;
  async function decide(decision: 'allow' | 'deny') {
    setPending(true); setError(null);
    try { await mutate({ action: 'permission', roomId: message.roomId, messageId: message.id, decision }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not apply permissions.'); }
    finally { setPending(false); }
  }
  return <ContentCard title="Permission request" icon={<ShieldCheck aria-hidden="true" />}
    status={pending ? 'Applying…' : request.status === 'pending' ? 'Needs approval' : request.status === 'allowed' ? 'Allowed' : 'Denied'}>
    <p>{request.reason}</p>
    <p>{[request.fileWrite && 'Modify project files', request.commandExecution && 'Run commands'].filter(Boolean).join(' · ')}</p>
    <p>Project: {workspace}</p>
    {request.status === 'pending' ? <>
      <p>Allow for this project until changed in Agent settings. The idle worker may be replaced; conversations are kept. Running or unresolved tasks must finish first.</p>
      <div className={styles.links}>
        <NeumorphicButton disabled={pending} onClick={() => { void decide('allow'); }}>Allow for project</NeumorphicButton>
        <NeumorphicButton variant="ghost" disabled={pending} onClick={() => { void decide('deny'); }}>Deny</NeumorphicButton>
      </div>
    </> : <p>{request.status === 'allowed' ? 'Permissions applied. Resume the task when ready. Saved task instructions still apply.' : 'Permission denied. The task remains paused.'}</p>}
    {error && <p role="alert">{error}</p>}
    {error?.includes('Project setup required:') && <ProjectEnvironmentSetup roomId={message.roomId} mutate={mutate} />}
  </ContentCard>;
}
