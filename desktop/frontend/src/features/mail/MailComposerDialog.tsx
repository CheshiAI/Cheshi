import { useEffect, useSyncExternalStore } from 'react';
import { Send } from 'lucide-react';
import { Modal } from '../../shared/ui';
import type { MailComposer } from './mailComposer';
import { MailComposerContent } from './MailComposerContent';

export function MailComposerDialog({ composer }: { composer: MailComposer }) {
  const state = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  useEffect(() => {
    const preventClose = (event: BeforeUnloadEvent) => {
      if (state.form || state.busy) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', preventClose);
    return () => window.removeEventListener('beforeunload', preventClose);
  }, [state.form, state.busy]);
  if (!state.visible || state.reply) return null;
  return <Modal title="New message" titleIcon={<Send aria-hidden="true" />}
    onClose={() => composer.hide()} closeDisabled={state.busy || state.loading}>
    <MailComposerContent composer={composer} />
  </Modal>;
}
