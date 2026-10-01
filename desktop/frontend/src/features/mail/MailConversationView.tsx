import type { ReactNode } from 'react';
import { mailTargetKey } from '../../../../shared/mail-conversation';
import type { MailConversationEntry } from '../../../../shared/mail-conversation';
import { NeumorphicButton } from '../../shared/ui';
import { MailActions } from './MailActions';
import { MailMessageContent } from './MailMessageContent';
import type { MailModel, MailState } from './mailModel';
import type { MailComposer } from './mailComposer';
import styles from './Mail.module.css';

interface Props { model: MailModel; state: MailState; composer: MailComposer; children: ReactNode }

export function MailConversationView({ model, state, composer, children }: Props) {
  const anchor = state.selectedBox && state.selectedId !== null
    ? mailTargetKey({ mailbox: state.selectedBox, id: state.selectedId }) : '';
  const rows = state.conversation?.messages ?? [];
  return <>
    {rows.length > 1 ? <div className={styles.conversation} aria-label="Mail conversation">
      {rows.map(entry => mailTargetKey(entry.target) === anchor
        ? <section key={anchor} className={styles.conversationMessage} aria-label="Selected message">
          {children}
        </section>
        : <RelatedMessage key={mailTargetKey(entry.target)} entry={entry} model={model} state={state}
          composer={composer} />)}
    </div> : children}
    {state.conversationError && <div className={styles.notice}><p role="alert">Could not load the conversation. {state.conversationError}</p>
      <NeumorphicButton variant="ghost" onClick={() => void model.refreshConversation()}>Retry conversation</NeumorphicButton></div>}
    {state.conversation?.incomplete && <p className={styles.notice} role="status">Some related messages could not be checked. This conversation may be incomplete.</p>}
  </>;
}

function RelatedMessage({ entry, model, state, composer }: Omit<Props, 'children'> & {
  entry: MailConversationEntry;
}) {
  const result = state.conversationMessages[mailTargetKey(entry.target)];
  const message = result?.ok ? result.value : null;
  const imagesAllowed = model.remoteImagesFor(entry.target);
  return <section className={styles.conversationMessage} aria-label={`Related message: ${entry.summary.subject}`}>
    <MailActions message={message} target={entry.target} boxes={state.boxes}
      disabled={state.changing || state.loadingBoxes || state.changeBlocked} onChange={input => model.change(input)}
      onReply={all => { if (message) void composer.start(message, entry.target, all, imagesAllowed); }} />
    {message ? <MailMessageContent message={message} remoteImagesAllowed={imagesAllowed} padded
      onLoadImages={() => model.allowConversationImages(entry.target)} />
      : result && !result.ok ? <div className={styles.notice}><p role="alert">{result.error.message}</p>
        <NeumorphicButton variant="ghost" disabled={state.loadingConversation}
          onClick={() => void model.refreshConversation()}>Retry related message</NeumorphicButton></div> : null}
  </section>;
}
