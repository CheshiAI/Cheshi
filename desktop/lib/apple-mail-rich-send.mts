import { appleMailScript } from './apple-mail-script.mts';
import { runMailPaste } from './apple-mail-rich-process.mts';
import { mailFailure, mailReply, mailSent } from '../shared/apple-mail.ts';
import type { MailSend, MailSent, MailReply } from '../shared/apple-mail.ts';

// Mail windows and the pasteboard are shared by all workspace services.
let active = false;
export async function sendRichMail(input: MailSend, execute: (source: string) => Promise<string>, paste = runMailPaste): Promise<MailReply<MailSent>> {
  if (active) return mailFailure('busy');
  active = true;
  let sending = false;
  let stage = 'permission';
  try {
    await paste({ action: 'check' });
    stage = 'prepare';
    const prepared = mailReply(JSON.parse(await execute(appleMailScript({ action: 'prepare-rich', input }))), value => {
      const result = value as { id?: unknown; title?: unknown } | null;
      if (!result || !Number.isSafeInteger(result.id) || (result.id as number) < 1 || result.title !== `Cheshi-${input.operationId}`) {
        throw new Error('preparation-failed');
      }
      return { id: result.id as number, title: result.title as string };
    });
    if (!prepared.ok) return prepared;
    stage = 'paste';
    await paste({ action: 'paste', title: prepared.value.title, html: input.html, body: input.body });
    sending = true;
    stage = 'send';
    return mailReply(JSON.parse(await execute(appleMailScript({ action: 'send-rich', input, outgoingId: prepared.value.id }))), value => mailSent(value, input.operationId));
  } catch (error) {
    process.stderr.write(`[cheshi] Mail delivery stopped at ${stage}.\n`);
    return mailFailure(sending ? 'send-unknown' : error instanceof Error && error.message === 'accessibility' ? 'accessibility' : 'preparation-failed');
  } finally { active = false; }
}
