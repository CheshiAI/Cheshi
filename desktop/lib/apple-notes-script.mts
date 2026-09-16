import { APPLE_NOTES_PAGE_SIZE } from '../shared/apple-notes.ts';
import type { AppleNoteCreateInput } from '../shared/apple-notes.ts';
import type { AppleNoteUpdateInput } from '../shared/apple-notes-document.ts';

export type AppleNotesCommand = { action: 'folders' } | { action: 'list'; folderId: string; offset: number }
  | { action: 'read' | 'delete' | 'document'; noteId: string } | ({ action: 'create' } & AppleNoteCreateInput)
  | ({ action: 'update' } & AppleNoteUpdateInput);

// Static JXA program: only JSON-encoded data crosses into the script. The script
// travels on stdin, so note contents never appear in process arguments or files.
const SCRIPT = String.raw`(function (request) {
  var creating = false;
  var deleting = false;
  var updating = false;
  function fail(code) { var error = new Error(code); error.notesCode = code; throw error; }
  function noteDate(note, property) {
    var date = typeof note[property] === 'function' ? note[property]() : null;
    return date && typeof date.toISOString === 'function' && isFinite(date.getTime()) ? date.toISOString() : '';
  }
  function summary(note) {
    var result = { id: note.id(), title: note.name(), modifiedAt: noteDate(note, 'modificationDate'),
      locked: note.passwordProtected() };
    var createdAt = noteDate(note, 'creationDate');
    if (createdAt) result.createdAt = createdAt;
    return result;
  }
  function escapeHtml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  try {
    var app = Application('com.apple.Notes');
    var result;
    if (request.action === 'folders') {
      result = [];
      var seen = {};
      var accounts = app.accounts();
      var defaultId = accounts.length ? app.defaultAccount().defaultFolder().id() : '';
      function walk(folders, account, parent, depth) {
        if (depth > 32) fail('invalid');
        folders.forEach(function (folder) {
          var id = folder.id();
          if (seen[id]) return;
          seen[id] = true;
          if (result.length >= 5000) fail('invalid');
          var name = folder.name();
          var path = parent ? parent + ' / ' + name : name;
          result.push({ id: id, name: name, account: account, path: path, isDefault: id === defaultId });
          walk(folder.folders(), account, path, depth + 1);
        });
      }
      accounts.forEach(function (account) { walk(account.folders(), account.name(), '', 0); });
    } else if (request.action === 'read' || request.action === 'delete' || request.action === 'document' || request.action === 'update') {
      var note = app.notes.byId(request.noteId);
      if (!note.exists()) fail('not-found');
      result = summary(note);
      if (result.locked !== false) fail(result.locked === true ? 'locked' : 'invalid');
      if (request.action === 'delete') {
        deleting = true;
        app.delete(note);
        result = { id: request.noteId };
      } else if (request.action === 'read') result.plaintext = note.plaintext();
      else {
        var original = note.body();
        var attachmentCount = note.attachments().length;
        if (request.action === 'update') {
          if (attachmentCount !== 0) fail('read-only');
          if (original !== request.expectedHtml || result.modifiedAt !== request.expectedModifiedAt
            || result.title !== request.expectedTitle) fail('conflict');
          updating = true;
          note.body = '<h1>' + escapeHtml(request.title) + '</h1>' + request.html;
          result = summary(note);
          original = note.body();
          attachmentCount = note.attachments().length;
        }
        result.plaintext = note.plaintext();
        result.html = original;
        result.attachmentCount = attachmentCount;
      }
    } else {
      var folder = app.folders.byId(request.folderId);
      if (!folder.exists()) fail('not-found');
      if (request.action === 'list') {
        var notes = folder.notes();
        var end = Math.min(notes.length, request.offset + PAGE_SIZE);
        result = { notes: notes.slice(request.offset, end).map(summary), nextOffset: end < notes.length ? end : null };
      } else if (request.action === 'create') {
        var body = '<h1>' + escapeHtml(request.title) + '</h1><pre>' + escapeHtml(request.body) + '</pre>';
        creating = true;
        var created = app.make({ new: 'note', at: folder, withProperties: { body: body } });
        result = { id: created.id(), title: created.name() };
      } else fail('invalid');
    }
    return JSON.stringify({ ok: true, value: result });
  } catch (error) {
    var number = Number(error.errorNumber || error.number || 0);
    var code = error.notesCode || (number === -1743 ? 'permission'
      : creating ? 'save-unknown' : deleting ? 'delete-unknown' : updating ? 'update-unknown' : number === -1728 ? 'not-found' : 'unavailable');
    return JSON.stringify({ ok: false, code: code });
  }
})`;

export function appleNotesScript(command: AppleNotesCommand): string {
  const payload = JSON.stringify(command).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `${SCRIPT.replace('PAGE_SIZE', String(APPLE_NOTES_PAGE_SIZE))}(${payload});\n`;
}
