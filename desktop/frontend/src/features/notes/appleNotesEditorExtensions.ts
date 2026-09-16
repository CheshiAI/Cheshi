import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Mark } from '@tiptap/react';
import { appleNoteFontSize } from '../../../../shared/apple-notes-document';

// Apple Notes exports text sizes as inline spans, including its title style.
// Retain body sizes in the document so an edit does not silently remove them.
const NoteFontSize = Mark.create({
  name: 'noteFontSize',
  addAttributes() {
    return { fontSize: { default: null, rendered: false } };
  },
  parseHTML() {
    return [{ tag: 'span[style]', getAttrs: element => {
      const fontSize = appleNoteFontSize(element.getAttribute('style') ?? '');
      return fontSize ? { fontSize } : false;
    } }];
  },
  renderHTML({ mark }) {
    return ['span', { style: `font-size: ${mark.attrs.fontSize}` }, 0];
  },
});

export function noteEditorExtensions() {
  return [StarterKit.configure({ link: { openOnClick: false, autolink: false }, trailingNode: false }), NoteFontSize, Markdown];
}
