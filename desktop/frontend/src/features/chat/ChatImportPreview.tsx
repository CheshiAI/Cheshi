import type { ReactNode } from 'react';
import { chatImportLabel, type ChatImportAttachment } from '../../../../shared/chat-imports';
import { chatLocalPathReferences } from './chatLocalPathEditor';
import styles from './ChatImportInput.module.css';

/** Read-only draft preview; leave unmatched references and paths untouched. */
export function ChatImportPreview({ text, attachments }: { text: string; attachments: readonly ChatImportAttachment[] }) {
  const imports = new Map(attachments.flatMap(item => item.importNumber === undefined
    ? [] : [[chatImportLabel(item.importNumber), item] as const]));
  const paths = chatLocalPathReferences(text);
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(/\[import [1-9]\d*\]/g)) {
    const attachment = imports.get(match[0]);
    if (!attachment || paths.some(path => path.from <= match.index && match.index < path.to)) continue;
    parts.push(text.slice(offset, match.index));
    parts.push(<span key={match.index} className={styles.chip} data-chat-import-number={attachment.importNumber}
      aria-label={`import ${attachment.importNumber}: ${attachment.name}`} title={attachment.name}>
      {`import ${attachment.importNumber}`}
    </span>);
    offset = match.index + match[0].length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}
