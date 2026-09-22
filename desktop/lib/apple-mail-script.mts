import { MAIL_BODY_LIMIT, MAIL_PAGE_SIZE } from '../shared/apple-mail.ts';
import type { MailboxRef, MailTarget, MailChange, MailSend } from '../shared/apple-mail.ts';

export type MailCommand = { action: 'mailboxes' } | { action: 'list'; mailbox: MailboxRef; offset: number }
  | { action: 'read'; target: MailTarget } | { action: 'accounts' }
  | { action: 'change'; input: MailChange } | { action: 'send'; input: MailSend };

// Values enter through JSON, never executable script interpolation.
const SCRIPT = String.raw`(function(request) {
  var changing = false;
  var sending = false;
  function fail(code) { var error = new Error(code); error.mailCode = code; throw error; }
  function string(value) { return typeof value === 'string' ? value.replace(/\0/g, '') : ''; }
  function date(value) { return value instanceof Date && isFinite(value.getTime()) ? value.toISOString() : null; }
  function summary(message) {
    return { id: message.id(), subject: string(message.subject()).slice(0, 10000),
      sender: string(message.sender()).slice(0, 4096), read: message.readStatus(), flagged: message.flaggedStatus(),
      date: date(message.dateReceived()) || date(message.dateSent()) };
  }
  try {
    var app = Application('com.apple.mail');
    function addresses(recipients) {
      return recipients().map(function(recipient) { return string(recipient.address()); });
    }
    function selectedMessage(target) {
      var message = mailbox(target.mailbox).messages.byId(target.id);
      if (!message.exists()) fail('not-found');
      return message;
    }
    function replaceRecipients(collection, values, constructor) {
      // JXA recipient references are positional. Removing an earlier entry shifts
      // later references, so delete from the end before adding the reviewed list.
      for (var index = collection.length - 1; index >= 0; index--) app.delete(collection[index]);
      values.forEach(function(address) { collection.push(constructor({address: address})); });
    }
    function sameAddresses(actual, expected) {
      function normalize(values) { return values.map(function(value) { return value.toLowerCase(); }).sort().join('\n'); }
      return normalize(actual) === normalize(expected);
    }
    function matchingIds(box, messageId, localId) {
      if (messageId) return box.messages.whose({messageId: messageId})().map(function(message) { return message.id(); });
      return box.messages.byId(localId).exists() ? [localId] : [];
    }
    function moveObserved(source, destination, target, messageId, previousIds) {
      try {
        return !source.messages.byId(target.id).exists()
          && matchingIds(destination, messageId, target.id).some(function(id) { return previousIds.indexOf(id) < 0; });
      } catch (error) {
        // Mail can invalidate a collection's positional references during sync.
        var number = Number(error.errorNumber || error.number || 0);
        if (number === -1719 || number === -1728) return false;
        throw error;
      }
    }
    function confirmMove(source, destination, target, messageId, previousIds) {
      // Mail can assign a new local ID and finish the mailbox update asynchronously.
      // Require removal from the source AND a newly arrived destination message;
      // an older copy with the same RFC Message-ID is not evidence of this move.
      for (var attempt = 0; attempt < 20; attempt++) {
        if (moveObserved(source, destination, target, messageId, previousIds)) return;
        if (attempt < 19) delay(0.25);
      }
      fail('change-unknown');
    }
    // Mail can enumerate a mailbox but reject a by-name specifier for it.
    // Resolve against the same collection used by the mailbox listing instead.
    function namedMailbox(boxes, name) {
      var count = boxes.length;
      var found = null;
      for (var index = 0; index < count; index++) {
        var candidate = boxes[index];
        if (candidate.name() === name) {
          if (found !== null) fail('ambiguous-mailbox');
          found = candidate;
        }
      }
      if (found === null) fail('not-found');
      return found;
    }
    function mailbox(ref) {
      var boxes;
      if (ref.accountId === null) boxes = app.mailboxes;
      else {
        var account = app.accounts.byId(ref.accountId);
        if (!account.exists()) fail('not-found');
        boxes = account.mailboxes;
      }
      var box;
      for (var i = 0; i < ref.path.length; i++) {
        box = namedMailbox(boxes, ref.path[i]);
        boxes = box.mailboxes;
      }
      return box;
    }
    var result;
    if (request.action === 'accounts') {
      result = app.accounts().filter(function(account) { return account.enabled() === true; }).map(function(account) {
        return { id: account.id(), name: account.name(), addresses: account.emailAddresses() };
      });
    } else if (request.action === 'change') {
      var input = request.input;
      var message = selectedMessage(input.target);
      var destination = input.action === 'move' ? mailbox(input.destination) : null;
      var source = destination ? mailbox(input.target.mailbox) : null;
      var originalMessageId = destination ? string(message.messageId()) : '';
      var previousIds = destination ? matchingIds(destination, originalMessageId, input.target.id) : [];
      changing = true;
      if (input.action === 'read') {
        message.readStatus = input.value;
        if (message.readStatus() !== input.value) fail('change-unknown');
      } else if (input.action === 'flag') {
        message.flaggedStatus = input.value;
        if (message.flaggedStatus() !== input.value) fail('change-unknown');
      } else if (input.action === 'move') {
        app.move(message, {to: destination});
        confirmMove(source, destination, input.target, originalMessageId, previousIds);
      } else fail('invalid');
      // Acknowledge the requested operation, not a reusable destination reference.
      // The renderer refreshes its mailbox after this acknowledgement.
      result = input.target;
    } else if (request.action === 'send') {
      var input = request.input;
      var account = app.accounts.byId(input.accountId);
      if (!account.exists() || account.enabled() !== true) fail('invalid');
      var allowed = account.emailAddresses().some(function(address) { return address.toLowerCase() === input.sender.toLowerCase(); });
      if (!allowed) fail('invalid');
      var original = input.reply ? selectedMessage(input.reply.target) : null;
      var outgoing;
      if (original) outgoing = app.reply(original, {openingWindow: false, replyToAll: input.reply.all});
      else { outgoing = app.OutgoingMessage({visible: false}); app.outgoingMessages.push(outgoing); }
      outgoing.sender = input.sender;
      outgoing.subject = input.subject;
      outgoing.content = input.body;
      replaceRecipients(outgoing.toRecipients, input.to, app.ToRecipient);
      replaceRecipients(outgoing.ccRecipients, input.cc, app.CcRecipient);
      replaceRecipients(outgoing.bccRecipients, input.bcc, app.BccRecipient);
      if (string(app.extractAddressFrom(outgoing.sender())).toLowerCase() !== input.sender.toLowerCase()
        || !sameAddresses(addresses(outgoing.toRecipients), input.to)
        || !sameAddresses(addresses(outgoing.ccRecipients), input.cc)
        || !sameAddresses(addresses(outgoing.bccRecipients), input.bcc)) fail('invalid');
      sending = true;
      if (app.send(outgoing) !== true) fail('send-unknown');
      result = {operationId: input.operationId, accepted: true};
    } else if (request.action === 'mailboxes') {
      result = [];
      var seen = {};
      function walk(boxes, accountId, accountName, parent) {
        var count = boxes.length;
        if (parent.length >= 32) { if (count > 0) fail('too-large'); return; }
        for (var i = 0; i < count; i++) {
          var box = boxes[i];
          var path = parent.concat([box.name()]);
          var key = JSON.stringify([accountId, path]);
          if (seen[key]) continue;
          seen[key] = true;
          if (result.length >= 5000) fail('too-large');
          result.push({ accountId: accountId, accountName: accountName, path: path, unread: box.unreadCount() });
          walk(box.mailboxes, accountId, accountName, path);
        }
      }
      var accounts = app.accounts();
      accounts.forEach(function(account) {
        if (account.enabled() === true) walk(account.mailboxes, account.id(), account.name(), []);
      });
      walk(app.mailboxes, null, '나의 Mac', []);
    } else if (request.action === 'list') {
      var messages = mailbox(request.mailbox).messages;
      var count = messages.length;
      var end = Math.min(count, request.offset + PAGE_SIZE);
      var rows = [];
      for (var index = request.offset; index < end; index++) rows.push(summary(messages[index]));
      result = { messages: rows, offset: request.offset, nextOffset: end < count ? end : null };
    } else if (request.action === 'read') {
      var message = selectedMessage(request.target);
      result = summary(message);
      var body = string(message.content());
      result.body = body.slice(0, BODY_LIMIT);
      result.bodyTruncated = body.length > BODY_LIMIT;
      result.to = addresses(message.toRecipients);
      result.cc = addresses(message.ccRecipients);
      result.replyTo = string(message.replyTo()) || string(app.extractAddressFrom(message.sender()));
    } else fail('invalid');
    return JSON.stringify({ ok: true, value: result });
  } catch (error) {
    var number = Number(error.errorNumber || error.number || 0);
    var code = sending ? 'send-unknown' : changing ? 'change-unknown'
      : error.mailCode || (number === -1743 ? 'permission' : number === -1728 ? 'not-found'
      : number === -1712 ? 'timeout' : 'unavailable');
    return JSON.stringify({ ok: false, error: { code: code } });
  }
})`;

export function appleMailScript(command: MailCommand): string {
  const payload = JSON.stringify(command).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `${SCRIPT.replaceAll('PAGE_SIZE', String(MAIL_PAGE_SIZE)).replaceAll('BODY_LIMIT', String(MAIL_BODY_LIMIT))}(${payload});\n`;
}
