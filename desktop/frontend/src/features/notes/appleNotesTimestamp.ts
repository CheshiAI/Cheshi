import type { AppleNoteSummary } from '../../../../shared/apple-notes';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

export function noteTimestamp(note: Pick<AppleNoteSummary, 'modifiedAt' | 'createdAt'>) {
  const dateTime = note.modifiedAt || note.createdAt;
  if (!dateTime) return null;
  return { dateTime, label: `${note.modifiedAt ? 'Updated' : 'Created'} ${dateFormat.format(new Date(dateTime))}` };
}
