import { MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DiscordApi, DiscordConfirmation } from '../../../../shared/discord';
import { Modal, NeumorphicButton } from '../../shared/ui';
import styles from './DiscordSetupConfirmation.module.css';

type ConfirmationApi = Pick<DiscordApi, 'getConfirmation' | 'onConfirmation' | 'respondConfirmation'>;

export function DiscordSetupConfirmation({ api }: { api?: ConfirmationApi }) {
  const [request, setRequest] = useState<DiscordConfirmation | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true, changed = false;
    const unsubscribe = api.onConfirmation(value => {
      changed = true;
      if (active) setRequest(value);
    });
    void api.getConfirmation().then(value => {
      if (active && !changed) setRequest(value);
    }).catch(console.error);
    return () => { active = false; unsubscribe(); };
  }, [api]);
  return request && api ? <ConfirmationDialog key={request.id} request={request} api={api} /> : null;
}

function ConfirmationDialog({ request, api }: { request: DiscordConfirmation; api: ConfirmationApi }) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (accepted: boolean) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(null);
    try {
      await api.respondConfirmation(request.id, accepted);
      // The main process publishes dismissal when it consumes this request.
    } catch (cause) {
      submitting.current = false; setBusy(false);
      setError(cause instanceof Error ? cause.message : 'Unable to confirm this server.');
    }
  };
  return <Modal title="CONNECT DISCORD" titleIcon={<MessageSquare aria-hidden="true" />}
    headerVariant="section" className={styles.dialog} closeDisabled={busy} onClose={() => { void respond(false); }}>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void respond(true); }}>
      <p>Use this personal Discord server?</p>
      <dl className={styles.details}>
        <div><dt>Server ID</dt><dd>{request.guildId}</dd></div>
        <div><dt>Owner ID</dt><dd>{request.ownerId}</dd></div>
        <div><dt>Device</dt><dd>{request.deviceName}</dd></div>
      </dl>
      <p className={styles.description}>Only you and your bot should be members.</p>
      {error && <p className={styles.description} role="alert">{error}</p>}
      <div className={styles.buttons}>
        <NeumorphicButton variant="standard" type="button" disabled={busy} onClick={() => { void respond(false); }}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" type="submit" disabled={busy} aria-busy={busy}>Use this server</NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
