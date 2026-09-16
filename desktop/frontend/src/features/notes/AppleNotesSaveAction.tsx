import { Check, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { AppleNotesSaveDialog } from './AppleNotesSaveDialog';
import { cheshiDesktop } from '../../cheshiDesktop';
import { NeumorphicButton, Tooltip } from '../../shared/ui';

export function AppleNotesSaveAction({ title, body }: { title: string; body: string }) {
  const api = cheshiDesktop?.appleNotes;
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!api?.available) return null;
  const label = saved ? 'Saved to Apple Notes' : 'Save response to Apple Notes';
  return <>
    <Tooltip content={label}>{props => <NeumorphicButton {...props} raised size="icon" aria-label={label}
      disabled={!body.trim()} onClick={() => setOpen(true)}>{saved ? <Check aria-hidden="true" /> : <StickyNote aria-hidden="true" />}</NeumorphicButton>}</Tooltip>
    {open && <AppleNotesSaveDialog api={api} initialTitle={title} body={body} onClose={() => setOpen(false)}
      onSaved={() => { setSaved(true); setOpen(false); }} />}
  </>;
}
