/**
 * Local non-nullable syntax-node types for web-tree-sitter.
 *
 * The upstream types declare children/namedChildren as (Node | null)[],
 * but in practice they never contain null entries. This override uses
 * non-nullable arrays to match native tree-sitter's API and avoid
 * pervasive null-check changes across the extraction pipeline.
 *
 * Runtime imports still resolve the installed package. Extraction modules use
 * this file only through relative `import type` statements, so Bun never treats
 * a declaration file as executable code.
 */
export interface Point {
    row: number;
    column: number;
  }

export interface Range {
    startPosition: Point;
    endPosition: Point;
    startIndex: number;
    endIndex: number;
  }

export interface Edit {
    startPosition: Point;
    oldEndPosition: Point;
    newEndPosition: Point;
    startIndex: number;
    oldEndIndex: number;
    newEndIndex: number;
  }

export type ParseCallback = (index: number, position: Point) => string | undefined;

export interface ParseOptions {
    includedRanges?: Range[];
    progressCallback?: (state: { currentOffset: number; hasError: boolean }) => void;
  }

export interface EmscriptenModule {
    [key: string]: any;
  }

//noinspection JSUnusedGlobalSymbols
export declare class Parser {
    language: Language | null;
    static init(moduleOptions?: EmscriptenModule): Promise<void>;
    constructor();
    delete(): void;
    setLanguage(language: Language | null): this;
    parse(callback: string | ParseCallback, oldTree?: Tree | null, options?: ParseOptions): Tree | null;
    reset(): void;
    getIncludedRanges(): Range[];
    getTimeoutMicros(): number;
    setTimeoutMicros(timeout: number): void;
    setLogger(callback: ((message: string, isLex: boolean) => void) | boolean | null): this;
    getLogger(): ((message: string, isLex: boolean) => void) | null;
  }

//noinspection JSUnusedGlobalSymbols
declare class LanguageMetadata {
  readonly major_version: number;
  readonly minor_version: number;
  readonly patch_version: number;
}

//noinspection JSUnusedGlobalSymbols
export declare class Language {
    types: string[];
    fields: (string | null)[];
    get name(): string | null;
    get version(): number;
    get abiVersion(): number;
    get metadata(): LanguageMetadata | null;
    get fieldCount(): number;
    get stateCount(): number;
    fieldIdForName(fieldName: string): number | null;
    fieldNameForId(fieldId: number): string | null;
    idForNodeType(type: string, named: boolean): number | null;
    get nodeTypeCount(): number;
    nodeTypeForId(typeId: number): string | null;
    nodeTypeIsNamed(typeId: number): boolean;
    nodeTypeIsVisible(typeId: number): boolean;
    get supertypes(): number[];
    subtypes(supertype: number): number[];
    nextState(stateId: number, typeId: number): number;
    lookaheadIterator(stateId: number): any;
    query(source: string): any;
    static load(input: string | Uint8Array): Promise<Language>;
  }

//noinspection JSUnusedGlobalSymbols
export declare class Tree {
    language: Language;
    copy(): Tree;
    delete(): void;
    get rootNode(): Node;
    rootNodeWithOffset(offsetBytes: number, offsetExtent: Point): Node;
    edit(edit: Edit): void;
    walk(): TreeCursor;
    getChangedRanges(other: Tree): Range[];
    getIncludedRanges(): Range[];
  }

//noinspection JSUnusedGlobalSymbols
export declare class Node {
    id: number;
    startIndex: number;
    startPosition: Point;
    tree: Tree;
    get typeId(): number;
    get grammarId(): number;
    get type(): string;
    get grammarType(): string;
    get isNamed(): boolean;
    get isExtra(): boolean;
    get isError(): boolean;
    get isMissing(): boolean;
    get hasChanges(): boolean;
    get hasError(): boolean;
    get endIndex(): number;
    get endPosition(): Point;
    get text(): string;
    get parseState(): number;
    get nextParseState(): number;
    equals(other: Node): boolean;
    child(index: number): Node | null;
    namedChild(index: number): Node | null;
    childForFieldId(fieldId: number): Node | null;
    childForFieldName(fieldName: string): Node | null;
    fieldNameForChild(index: number): string | null;
    fieldNameForNamedChild(index: number): string | null;
    childrenForFieldName(fieldName: string): Node[];
    childrenForFieldId(fieldId: number): Node[];
    firstChildForIndex(index: number): Node | null;
    firstNamedChildForIndex(index: number): Node | null;
    get childCount(): number;
    get namedChildCount(): number;
    get firstChild(): Node | null;
    get firstNamedChild(): Node | null;
    get lastChild(): Node | null;
    get lastNamedChild(): Node | null;
    // Override: non-nullable arrays (tree-sitter never returns null in these)
    get children(): Node[];
    get namedChildren(): Node[];
    descendantsOfType(types: string | string[], startPosition?: Point, endPosition?: Point): Node[];
    get nextSibling(): Node | null;
    get previousSibling(): Node | null;
    get nextNamedSibling(): Node | null;
    get previousNamedSibling(): Node | null;
    get descendantCount(): number;
    get parent(): Node | null;
    childWithDescendant(descendant: Node): Node | null;
    descendantForIndex(start: number, end?: number): Node | null;
    namedDescendantForIndex(start: number, end?: number): Node | null;
    descendantForPosition(start: Point, end?: Point): Node | null;
    namedDescendantForPosition(start: Point, end?: Point): Node | null;
    walk(): TreeCursor;
    edit(edit: Edit): void;
    toString(): string;
  }

//noinspection JSUnusedGlobalSymbols
export declare class TreeCursor {
    copy(): TreeCursor;
    delete(): void;
    get currentNode(): Node;
    get currentFieldId(): number;
    get currentFieldName(): string | null;
    get currentDepth(): number;
    get currentDescendantIndex(): number;
    get nodeType(): string;
    get nodeTypeId(): number;
    get nodeStateId(): number;
    get nodeId(): number;
    get nodeIsNamed(): boolean;
    get nodeIsMissing(): boolean;
    get nodeText(): string;
    get startPosition(): Point;
    get endPosition(): Point;
    get startIndex(): number;
    get endIndex(): number;
    gotoFirstChild(): boolean;
    gotoLastChild(): boolean;
    gotoParent(): boolean;
    gotoNextSibling(): boolean;
    gotoPreviousSibling(): boolean;
    gotoDescendant(goalDescendantIndex: number): void;
    gotoFirstChildForIndex(goalIndex: number): boolean;
    gotoFirstChildForPosition(goalPosition: Point): boolean;
    reset(node: Node): void;
    resetTo(cursor: TreeCursor): void;
}
