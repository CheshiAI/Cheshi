import type { ChatTimelineItem } from './model';

/** Keep separate item identities while displaying consecutive summaries together. */
export function groupReasoningItems(items: ChatTimelineItem[]): [ChatTimelineItem, ...ChatTimelineItem[]][] {
  const groups: [ChatTimelineItem, ...ChatTimelineItem[]][] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (item.kind === 'reasoning' && previous?.[0].kind === 'reasoning' && previous[0].turnId === item.turnId) {
      previous.push(item);
    } else groups.push([item]);
  }
  return groups;
}

/** Older streamed records joined adjacent bold summary headings without a separator. */
export function reasoningMarkdown(text: string): string {
  let fence: string | null = null;
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return line;
    }
    if (fence || !/^(?:\*\*[^*\r\n]+\*\*){2,}\r?$/.test(line)) return line;
    return line.replace(/\*\*\*\*/g, '**\n\n**');
  }).join('\n');
}
