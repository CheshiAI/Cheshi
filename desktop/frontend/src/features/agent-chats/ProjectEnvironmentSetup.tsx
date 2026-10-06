import { useState } from 'react';
import type { ChatsRequest } from '../../../../shared/agent-chats';
import { NeumorphicButton } from '../../shared/ui';

export function ProjectEnvironmentSetup({ roomId, mutate }: { roomId: string; mutate(request: ChatsRequest): Promise<unknown> }) {
  const [pending, setPending] = useState(false), [message, setMessage] = useState<string | null>(null);
  return <>
    <p>Enable a writable share for this project and restart its Colima VM. Stop all containers in that VM first. Each Homie keeps its own file permissions.</p>
    <NeumorphicButton disabled={pending} onClick={async () => {
      setPending(true); setMessage(null);
      try { await mutate({ action: 'project-setup', roomId }); setMessage('Project share is ready. Retry the worker or permission request.'); }
      catch (e) { setMessage(e instanceof Error ? e.message : 'Project setup failed.'); }
      finally { setPending(false); }
    }}>{pending ? 'Preparing project…' : 'Enable project share and restart VM'}</NeumorphicButton>
    {message && <p role="status">{message}</p>}
  </>;
}
