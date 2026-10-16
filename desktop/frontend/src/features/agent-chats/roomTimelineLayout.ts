import type { RoomMessage } from '../../../../shared/agent-chats';

export const MAX_TIMELINE_ROWS = 80;
const ESTIMATED_HEIGHT = 180;
const OVERSCAN = 20;

export interface TimelineWindow { start: number; end: number; before: number; after: number }

/** Only heights and identities are retained for offscreen rows, never their DOM. */
export class RoomTimelineLayout {
  private ids: string[] = [];
  private positions = new Map<string, number>();
  private heights = new Map<string, number>();
  private offsets: number[] = [0];
  private width = 0;

  update(messages: RoomMessage[]) {
    this.ids = messages.map(message => message.id);
    this.positions = new Map(this.ids.map((id, index) => [id, index]));
    for (const id of this.heights.keys()) if (!this.positions.has(id)) this.heights.delete(id);
    this.rebuild();
  }

  private rebuild() {
    this.offsets = [0];
    for (const id of this.ids) this.offsets.push(this.offsets.at(-1)! + (this.heights.get(id) ?? ESTIMATED_HEIGHT));
  }

  measure(rows: Iterable<readonly [string, number]>, width: number) {
    let changed = false;
    if (width > 0 && width !== this.width) {
      this.width = width; this.heights.clear(); changed = true;
    }
    for (const [id, height] of rows) {
      if (!this.positions.has(id) || !Number.isFinite(height) || height <= 0) continue;
      if (Math.abs((this.heights.get(id) ?? ESTIMATED_HEIGHT) - height) < 0.5) continue;
      this.heights.set(id, height); changed = true;
    }
    if (changed) this.rebuild();
    return changed;
  }

  offset(id: string) {
    const index = this.positions.get(id);
    return index === undefined ? undefined : this.offsets[index];
  }

  private indexAt(top: number) {
    let low = 0, high = this.ids.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offsets[middle + 1]! <= top) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, Math.max(0, this.ids.length - 1));
  }

  anchor(top: number) {
    const index = this.indexAt(top), id = this.ids[index];
    return id ? { id, offset: this.offsets[index]! - top } : undefined;
  }

  window(top: number, viewport: number, pinned: boolean): TimelineWindow {
    const count = this.ids.length;
    if (count <= MAX_TIMELINE_ROWS) return { start: 0, end: count, before: 0, after: 0 };
    const first = this.indexAt(top), last = this.indexAt(top + viewport);
    const start = pinned ? Math.max(0, count - MAX_TIMELINE_ROWS) : Math.max(0, first - OVERSCAN);
    const end = pinned ? count : Math.min(count, start + MAX_TIMELINE_ROWS, Math.max(first + 1, last + OVERSCAN + 1));
    return { start, end, before: this.offsets[start]!, after: this.offsets[count]! - this.offsets[end]! };
  }
}
