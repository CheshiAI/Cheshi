/** The draft APIs need text offsets, independently of the rendered input. */
export interface ChatInputHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: 'forward' | 'backward' | 'none';
  focus(): void;
  contains(node: Node | null): boolean;
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void;
}
