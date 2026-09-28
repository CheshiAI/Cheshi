import { RefreshCw } from 'lucide-react';
import type { RefObject } from 'react';
import { LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import { useChatPermissions, type ChatPermissionController } from './useChatPermissions';
import type { ChatPermissionMode } from './model';
import styles from './ChatPermissionSelect.module.css';

interface PermissionSelectViewProps {
  choices: readonly ChatPermissionMode[];
  selected: ChatPermissionMode | null;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onChange: (id: string) => void;
  onRetry: () => void;
  menuBlurSourceRef?: RefObject<HTMLElement | null>;
}

export function ChatPermissionSelectView({ choices, selected, busy, disabled, error, onChange, onRetry, menuBlurSourceRef }: PermissionSelectViewProps) {
  const unavailable = disabled || busy || choices.length === 0;
  return (
    <div className={styles.root}>
      <LiquidGlassSelect ariaLabel="Chat permissions" busy={busy} className={styles.select}
        menuBlurSourceRef={menuBlurSourceRef}
        triggerAppearance="standard" menuAppearance="toolbar" disabled={unavailable} value={selected?.id ?? ''} placeholder="Read only"
        title={selected?.description ?? 'Read only by default. Select what Codex can do in this chat.'}
        options={choices.map((mode) => ({ value: mode.id, label: mode.label,
          disabled: !mode.allowed, description: mode.description }))}
        onChange={onChange} />
      {error && <>
        <span className={styles.error} role="alert" title={error}>{error}</span>
        <NeumorphicButton variant="standard" size="icon" aria-label="Retry permission options" title="Retry permission options"
          disabled={disabled || busy} onClick={onRetry}><RefreshCw aria-hidden="true" /></NeumorphicButton>
      </>}
    </div>
  );
}

export function ChatPermissionSelect({ controller, disabled = false, permissionPending = false, menuBlurSourceRef }: {
  controller: ChatPermissionController;
  disabled?: boolean;
  permissionPending?: boolean;
  menuBlurSourceRef?: RefObject<HTMLElement | null>;
}) {
  const permissions = useChatPermissions(controller, disabled || permissionPending);
  return <ChatPermissionSelectView {...permissions} busy={permissions.loading || permissions.changing || permissionPending}
    menuBlurSourceRef={menuBlurSourceRef}
    disabled={disabled} onChange={(id) => void permissions.choose(id)} onRetry={() => void permissions.refresh()} />;
}
