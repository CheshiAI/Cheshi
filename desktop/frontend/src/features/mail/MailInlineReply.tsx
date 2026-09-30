import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { MailComposerContent } from './MailComposerContent';
import type { MailComposer } from './mailComposer';
import styles from './MailInlineReply.module.css';

export function MailInlineReply({ composer, active, onLoadImages }: {
  composer: MailComposer; active: boolean; onLoadImages: () => void;
}) {
  const state = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const title = state.reply?.all ? 'Reply all' : 'Reply';
  return <section className={styles.root} aria-label={title} aria-busy={state.loading || state.busy}>
    <div className={styles.heading}>
      <h2>{title}</h2>
      <TooltipButton variant="ghost" size="icon" title="Close and keep draft" aria-label="Close reply"
        disabled={state.busy || state.loading} onClick={() => composer.hide()}><X aria-hidden="true" /></TooltipButton>
    </div>
    <MailComposerContent composer={composer} inline active={active} onLoadImages={onLoadImages} />
    {!state.loading && !state.form && <NeumorphicButton variant="ghost" onClick={() => void composer.start(
      state.original ?? undefined, state.reply?.target, state.reply?.all, state.remoteImagesAllowed,
    )}>Retry sending accounts</NeumorphicButton>}

  </section>;
}
