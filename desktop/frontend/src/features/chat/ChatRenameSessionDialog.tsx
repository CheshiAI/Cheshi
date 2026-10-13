import { RenameDialog } from '../../shared/ui/RenameDialog';

export function ChatRenameSessionDialog({ sessionTitle, onSave, onClose }: {
  sessionTitle: string;
  onSave(title: string): Promise<unknown>;
  onClose(): void;
}) {
  return <RenameDialog initialTitle={sessionTitle} heading="RENAME CHAT" inputLabel="Session title" onSave={onSave} onClose={onClose} />;
}
