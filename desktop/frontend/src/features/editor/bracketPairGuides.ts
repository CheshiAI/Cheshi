import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

interface BracketToken {
  bracket: string;
  owner: SyntaxNode;
  from: number;
  line: number;
  column: number;
  depth: number;
}

interface BracketPair extends BracketToken {
  to: number;
  closeLine: number;
}

export interface BracketPairGuideLine {
  line: number;
  guides: Array<{ column: number; depth: number; active: boolean }>;
}

const openingBrackets = new Set(['{']);
const closingBrackets = new Map([['}', '{']]);
const declarationBodyNodeNames = new Set([
  'Block',
  'ClassBody',
  'CompoundStatement',
  'EnumBody',
  'FieldDeclarationList',
  'StructBody',
  'SwitchBody',
]);

function hasDeclarationAnchor(node: SyntaxNode): boolean {
  // Continued declarations anchor at their starting line. Object expressions,
  // inline types and destructuring instead keep their opening-line indentation.
  return declarationBodyNodeNames.has(node.name)
    || (node.name === 'ObjectType' && node.parent?.name === 'InterfaceDeclaration');
}

function indentationColumn(text: string, tabSize: number): number {
  let column = 0;
  for (const character of text) {
    if (character === ' ') column += 1;
    else if (character === '\t') column += tabSize - (column % tabSize);
    else break;
  }
  return column;
}

function blockGuideColumn(state: EditorState, block: SyntaxNode, opening: number): number {
  const owner = block.parent;
  // A continued signature/condition may indent the opening-brace line farther
  // than its declaration. Standalone blocks keep their own indentation.
  const anchor = hasDeclarationAnchor(block) && owner && !owner.type.isTop && !hasDeclarationAnchor(owner)
    ? owner.from
    : opening;
  return indentationColumn(state.doc.lineAt(anchor).text, state.tabSize);
}

function bracketPairs(state: EditorState): BracketPair[] {
  const pairs = [];
  const stack: BracketToken[] = [];
  const cursor = syntaxTree(state).cursor();
  do {
    if (cursor.to !== cursor.from + 1) continue;
    // Only structural brace tokens qualify, never string/comment contents or
    // an interpolation's closing token. Do not restrict the owning node kind.
    if (cursor.name !== '{' && cursor.name !== '}') continue;
    const block = cursor.node.parent;
    if (!block) continue;
    const bracket = state.sliceDoc(cursor.from, cursor.to);
    if (openingBrackets.has(bracket)) {
      const line = state.doc.lineAt(cursor.from);
      stack.push({
        bracket,
        owner: block,
        from: cursor.from,
        line: line.number,
        column: blockGuideColumn(state, block, cursor.from),
        depth: stack.length,
      });
      continue;
    }
    const expectedOpening = closingBrackets.get(bracket);
    if (!expectedOpening) continue;
    let openingIndex = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const candidate = stack[index]!;
      if (candidate.bracket === expectedOpening && candidate.owner.type === block.type
        && candidate.owner.from === block.from && candidate.owner.to === block.to) {
        openingIndex = index;
        break;
      }
    }
    if (openingIndex < 0) continue;
    const opening = stack[openingIndex]!;
    stack.splice(openingIndex);
    const closeLine = state.doc.lineAt(cursor.from).number;
    if (closeLine <= opening.line + 1) continue;
    pairs.push({ ...opening, to: cursor.to, closeLine });
  } while (cursor.next());
  return pairs;
}

function guideLinesFromPairs(
  state: EditorState,
  pairs: readonly BracketPair[],
  visibleFrom = 0,
  visibleTo = state.doc.length,
): BracketPairGuideLine[] {
  if (pairs.length === 0) return [];
  const selection = state.selection.main.head;
  let activePair: BracketPair | null = null;
  for (const pair of pairs) {
    if (selection <= pair.from || selection >= pair.to) continue;
    if (!activePair || pair.to - pair.from < activePair.to - activePair.from) activePair = pair;
  }
  const firstLine = state.doc.lineAt(Math.min(Math.max(visibleFrom, 0), state.doc.length)).number;
  const lastLine = state.doc.lineAt(Math.min(Math.max(visibleTo, 0), state.doc.length)).number;
  const guidesByLine = new Map<number, Map<number, { column: number; depth: number; active: boolean }>>();
  for (const pair of pairs) {
    const startLine = Math.max(pair.line + 1, firstLine);
    const endLine = Math.min(pair.closeLine - 1, lastLine);
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const guides = guidesByLine.get(lineNumber) ?? new Map();
      const current = guides.get(pair.column);
      const guide = {
        column: pair.column,
        depth: pair.depth,
        active: pair === activePair,
      };
      if (!current || guide.active || (!current.active && guide.depth > current.depth)) {
        guides.set(pair.column, guide);
      }
      guidesByLine.set(lineNumber, guides);
    }
  }
  return [...guidesByLine.entries()]
    .sort(([left], [right]) => left - right)
    .map(([line, guides]) => ({
      line,
      guides: [...guides.values()].sort((left, right) => left.column - right.column),
    }));
}

export function bracketPairGuideLines(
  state: EditorState,
  visibleFrom = 0,
  visibleTo = state.doc.length,
): BracketPairGuideLine[] {
  return guideLinesFromPairs(state, bracketPairs(state), visibleFrom, visibleTo);
}

function guideStyle(guides: BracketPairGuideLine['guides']): string {
  const images = guides.map((guide) => (
    `linear-gradient(${guide.active
      ? 'var(--editor-bracket-guide-active)'
      : `var(--editor-bracket-guide-${guide.depth % 3})`}, ${guide.active
      ? 'var(--editor-bracket-guide-active)'
      : `var(--editor-bracket-guide-${guide.depth % 3})`})`
  ));
  const positions = guides.map((guide) => `calc(14px + ${guide.column}ch) 0`);
  return [
    `background-image:${images.join(',')}`,
    `background-position:${positions.join(',')}`,
    `background-size:${guides.map(() => '1px 100%').join(',')}`,
    'background-repeat:no-repeat',
  ].join(';');
}

function guideDecorations(view: EditorView, pairs: readonly BracketPair[]): DecorationSet {
  const decorations = [];
  for (const visible of view.visibleRanges) {
    for (const line of guideLinesFromPairs(view.state, pairs, visible.from, visible.to)) {
      decorations.push(Decoration.line({
        attributes: {
          class: 'workspace-editor-bracket-guide-line',
          style: guideStyle(line.guides),
        },
      }).range(view.state.doc.line(line.line).from));
    }
  }
  return Decoration.set(decorations, true);
}

const bracketPairGuidePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  pairs: BracketPair[];

  constructor(view: EditorView) {
    this.pairs = bracketPairs(view.state);
    this.decorations = guideDecorations(view, this.pairs);
  }

  update(update: ViewUpdate): void {
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (update.docChanged || treeChanged) this.pairs = bracketPairs(update.state);
    if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged) {
      this.decorations = guideDecorations(update.view, this.pairs);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

export function bracketPairGuides(): Extension {
  return bracketPairGuidePlugin;
}
