import { APPLE_NOTES_MAX_TITLE_LENGTH, type AppleNoteCreateInput } from '../../../../shared/apple-notes';

/** The first line is metadata only; the complete text supplies the native body. */
export function appleNotesTextExport(body: string) {
  const title = body.split(/\r\n?|\n/, 1)[0]?.trim().slice(0, APPLE_NOTES_MAX_TITLE_LENGTH) || 'Untitled note';
  const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // The inner code element also preserves an initial newline that HTML would
  // otherwise discard immediately after an opening pre tag.
  return { title, body, html: `<pre><code>${escaped}</code></pre>`, htmlIncludesTitle: true } satisfies Omit<AppleNoteCreateInput, 'folderId'>;
}
