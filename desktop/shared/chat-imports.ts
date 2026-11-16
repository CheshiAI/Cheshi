/** Stable, message-local attachment references shared by the renderer and native runtime. */
export interface ChatImportAttachment {
  kind: 'image' | 'file';
  name: string;
  path: string;
  importNumber?: number;
}

export type NumberedChatImport = ChatImportAttachment & { importNumber: number };
const START = '\n\nAttached imports:\n<cheshi-imports-v1>\n';
const END = '\n</cheshi-imports-v1>';
export const chatImportLabel = (number: number): string => `[import ${number}]`;

export function chatImportNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new TypeError('Attachment import number is invalid.');
  }
  return value;
}

export function assertChatImportNumbers(attachments: readonly ChatImportAttachment[]): void {
  const used = new Set<number>();
  for (const attachment of attachments) {
    const number = chatImportNumber(attachment.importNumber);
    if (number === undefined) continue;
    if (used.has(number)) throw new TypeError('Attachment import numbers must be unique within a message.');
    used.add(number);
  }
}

/** The explicit mapping reaches the model and survives thread/read without a separate database. */
export function messageWithChatImports(message: string, attachments: readonly ChatImportAttachment[]): string {
  assertChatImportNumbers(attachments);
  const files = attachments.filter(item => item.kind === 'file' && item.importNumber === undefined);
  const text = files.length ? `${message}\n\nAttached files:\n${files.map(item => `- ${JSON.stringify(item.path)}`).join('\n')}` : message;
  let imageNumber = 0;
  const imports = attachments.flatMap(item => {
    if (item.kind === 'image') imageNumber++;
    return item.importNumber === undefined ? [] : [{
      importNumber: item.importNumber, label: chatImportLabel(item.importNumber),
      kind: item.kind, name: item.name, path: item.path,
      ...(item.kind === 'image' ? { imageNumber } : {}),
    }];
  });
  return imports.length ? `${text}${START}${JSON.stringify(imports)}${END}` : text;
}

/** Match native history's local-image markers for optimistic and temporary messages. */
export function displayMessageWithChatImports(message: string, attachments: readonly ChatImportAttachment[]): string {
  return [messageWithChatImports(message, attachments), ...attachments
    .filter(item => item.kind === 'image').map(item => `[Image: ${item.path}]`)].join('\n\n');
}

export function parseChatImports(text: string): { text: string; imports: NumberedChatImport[] } | null {
  const start = text.lastIndexOf(START);
  if (start < 0) return null;
  const end = text.indexOf(END, start + START.length);
  if (end < 0) return null;
  const encoded = text.slice(start + START.length, end);
  if (encoded.length > 128_000) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!Array.isArray(value) || !value.length || value.length > 20) return null;
    const imports: NumberedChatImport[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      if ((item.kind !== 'image' && item.kind !== 'file')
        || typeof item.name !== 'string' || !item.name || typeof item.path !== 'string' || !item.path
        || !/^(?:\/(?!\/)|[a-z]:[\\/])/i.test(item.path) || /[\u0000-\u001f]/.test(item.path)) return null;
      const importNumber = chatImportNumber(item.importNumber);
      if (importNumber === undefined) return null;
      imports.push({ importNumber, kind: item.kind, name: item.name, path: item.path });
    }
    assertChatImportNumbers(imports);
    const tail = text.slice(end + END.length);
    const markers = tail.split('\n').filter(line => line.trim());
    if (markers.some(line => !/^\[Image: .+\]$/.test(line))) return null;
    const imagePaths = new Set(imports.filter(item => item.kind === 'image').map(item => item.path));
    const remaining = markers.filter(line => !imagePaths.has(line.slice(8, -1)));
    return { text: [text.slice(0, start), ...remaining].join('\n\n'), imports };
  } catch { return null; }
}

/** Markdown shortcut references leave inline code and fenced examples untouched. */
export function chatImportMarkdown(text: string, imports: readonly NumberedChatImport[]): string {
  return `${text}\n\n${imports.map(item => `${chatImportLabel(item.importNumber)}: #cheshi-import-${item.importNumber}`).join('\n')}`;
}
