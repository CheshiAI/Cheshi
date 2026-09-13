import * as path from 'path';
import {
  ExtractionResult,
  Node,
  NodeKind
} from '../types';
import type { Node as SyntaxNode, Tree } from '../web-tree-sitter';
import { getParser, isLanguageSupported } from './grammars';
import { generateNodeId } from './tree-sitter-helpers';
import type { TreeSitterState } from './tree-sitter-state';
import {
  requireParsedTree
} from './tree-sitter-syntax';
import type { ExtractorContext } from './tree-sitter-types';

/**
   * Parse and extract from the source code
   */
export function extract(this: TreeSitterState): ExtractionResult {
  const startTime = Date.now();

  if (!isLanguageSupported(this.language)) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `Unsupported language: ${this.language}`,
          filePath: this.filePath,
          severity: 'error',
          code: 'unsupported_language',
        },
      ],
      durationMs: Date.now() - startTime,
    };
  }

  const parser = getParser(this.language);
  if (!parser) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `Failed to get parser for language: ${this.language}`,
          filePath: this.filePath,
          severity: 'error',
          code: 'parser_error',
        },
      ],
      durationMs: Date.now() - startTime,
    };
  }

  try {
    // Optional pre-parse source transform (offset-preserving) to work around
    // grammar gaps — e.g. C# blanks conditional-compilation directive lines
    // the grammar mis-parses inside enum bodies (#237). We reassign
    // this.source so downstream getNodeText reads the same bytes the parser
    // saw (identical outside the blanked directive lines). Skipped when the
    // kernel route point already applied it (sourceIsPreParsed).
    if (this.extractor?.preParse && !this.sourceIsPreParsed) {
      this.source = this.extractor.preParse(this.source, this.filePath);
    }
    // web-tree-sitter's generated declarations overstate child arrays as
    // nullable; the local extraction type records the runtime invariant.
    this.tree = requireParsedTree((parser.parse(this.source) as unknown as Tree | null) ?? null);

    // Create file node representing the source file
    const fileNode: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: this.language,
      startLine: 1,
      endLine: this.source.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);

    // Push file node onto stack so top-level declarations get contains edges
    this.nodeStack.push(fileNode.id);

    // File-level package declaration (Kotlin/Java). Creates an implicit
    // `namespace` node wrapping every top-level declaration so their
    // qualifiedName carries the FQN — required for cross-file import
    // resolution on JVM languages where filename ≠ class name.
    const packageNodeId = this.extractFilePackage(this.tree.rootNode);
    if (packageNodeId) this.nodeStack.push(packageNodeId);

    this.visitNode(this.tree.rootNode);

    // Gate + flush function-as-value candidates (#756) while the file's
    // nodes and import refs are complete and the file node is still pushed.
    this.flushFnRefCandidates();
    this.flushValueRefs();

    if (packageNodeId) this.nodeStack.pop();
    this.nodeStack.pop();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // WASM memory errors leave the module in a corrupted state — all subsequent
    // parses would also fail. Re-throw so the worker can detect and crash,
    // forcing a clean restart with a fresh heap.
    if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
      throw error;
    }

    this.errors.push({
      message: `Parse error: ${msg}`,
      filePath: this.filePath,
      severity: 'error',
      code: 'parse_error',
    });
  } finally {
    // Free tree-sitter WASM memory immediately — trees hold native heap memory
    // invisible to V8's GC that accumulates across thousands of files.
    if (this.tree) {
      this.tree.delete();
      this.tree = null;
    }
    // Release source string to reduce GC pressure
    this.source = '';
  }

  return {
    nodes: this.nodes,
    edges: this.edges,
    unresolvedReferences: this.unresolvedReferences,
    errors: this.errors,
    durationMs: Date.now() - startTime,
  };
}

/**
   * Create a Node object
   */
export function createNode(this: TreeSitterState, kind: NodeKind, name: string, node: SyntaxNode, extra?: Partial<Node>): Node | null {
  // Skip nodes with empty/missing names — they are not meaningful symbols
  // and would cause FK violations when edges reference them (see issue #42)
  if (!name) {
    return null;
  }

  const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

  // Some grammars (e.g. Dart) model a function/method body as a *sibling* of
  // the signature node, so the declaration node's own range is just the
  // signature line. Extend endLine to the resolved body when it sits beyond
  // the node so the node spans its body — required for any body-level analysis
  // (callees, the callback synthesizer's body scan, context slices). Guarded to
  // only ever extend: for child-body grammars the body is within range (no-op).
  let endLine = node.endPosition.row + 1;
  if (kind === 'function' || kind === 'method') {
    const body = this.extractor?.resolveBody?.(node, this.extractor.bodyField);
    if (body && body.endPosition.row + 1 > endLine) {
      endLine = body.endPosition.row + 1;
    }
  }

  const newNode: Node = {
    id,
    kind,
    name,
    qualifiedName: this.buildQualifiedName(name),
    filePath: this.filePath,
    language: this.language,
    startLine: node.startPosition.row + 1,
    endLine,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    updatedAt: Date.now(),
    ...extra,
  };

  // Persist extra symbol-level modifiers (e.g. Kotlin `expect`/`actual`) onto
  // the node's decorators list so the resolver can pair multiplatform
  // declarations with their implementations. Merged, not overwritten, so a
  // language that also captures real annotations keeps both.
  const mods = this.extractor?.extractModifiers?.(node);
  if (mods && mods.length > 0) {
    newNode.decorators = [...(newNode.decorators ?? []), ...mods];
  }

  this.nodes.push(newNode);

  // Add containment edge from parent
  if (this.nodeStack.length > 0) {
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (parentId) {
      this.edges.push({
        source: parentId,
        target: id,
        kind: 'contains',
      });
    }
  }

  if (this.valueRefsEnabled) this.captureValueRefScope(kind, name, id, node);

  return newNode;
}

/**
   * Find first named child whose type is in the given list.
   * Used to locate inner type nodes (e.g. enum_specifier inside a typedef).
   */
export function findChildByTypes(this: TreeSitterState, node: SyntaxNode, types: string[]): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

/**
   * Find a `packageTypes` child under the root, create a `namespace` node
   * for it, and return its id so the caller can scope top-level
   * declarations underneath. Returns null when no package header is
   * present (script files, .kts without a package).
   */
export function extractFilePackage(this: TreeSitterState, rootNode: SyntaxNode): string | null {
  const types = this.extractor?.packageTypes;
  if (!types || types.length === 0 || !this.extractor?.extractPackage) return null;

  let pkgNode: SyntaxNode | null = null;
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const child = rootNode.namedChild(i);
    if (child && types.includes(child.type)) {
      pkgNode = child;
      break;
    }
  }
  if (!pkgNode) return null;

  const pkgName = this.extractor.extractPackage(pkgNode, this.source);
  if (!pkgName) return null;

  const ns = this.createNode('namespace', pkgName, pkgNode);
  return ns?.id ?? null;
}

/**
   * Qualified name for a method defined out-of-line via a receiver qualifier
   * (`Type::method() {}`). The declarator spells the receiver RELATIVE to the
   * enclosing namespace, so the active C++ namespace prefix must be composed
   * in — `namespace sim { Output ManifestStartup::Apply() {} }` previously
   * indexed as `ManifestStartup::Apply` while the class node carried
   * `sim::ManifestStartup`, so qualified call sites
   * (`sim::ManifestStartup::Apply(...)`) never resolved (#1291).
   *
   * The source may also re-spell part or all of the namespace path
   * (`namespace sim { void sim::M::f() {} }` is legal), so the receiver is
   * anchored at the first prefix segment it names: everything before that
   * anchor is taken from the prefix, the receiver supplies the rest. A
   * receiver naming no prefix segment gets the whole prefix prepended.
   * `namespacePrefix` is only ever non-empty for C++, so every other
   * receiver language (Go, Rust, Kotlin, Lua) passes through unchanged.
   */
export function composeReceiverQualifiedName(this: TreeSitterState, receiverType: string, name: string): string {
  const base = `${receiverType}::${name}`;
  if (this.namespacePrefix.length === 0) return base;
  const receiverHead = receiverType.split('::')[0];
  const anchor = this.namespacePrefix.indexOf(receiverHead!);
  const prefix = anchor === -1 ? this.namespacePrefix : this.namespacePrefix.slice(0, anchor);
  return prefix.length > 0 ? `${prefix.join('::')}::${base}` : base;
}

/**
   * Build qualified name from node stack
   */
export function buildQualifiedName(this: TreeSitterState, name: string): string {
  // Build a qualified name from the semantic hierarchy only (no file path).
  // The file path is stored separately in filePath and pollutes FTS if included here.
  // C/C++ enclosing namespaces prefix first (empty for every other language).
  const parts: string[] = [...this.namespacePrefix];
  for (const nodeId of this.nodeStack) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (node && node.kind !== 'file') {
      parts.push(node.name);
    }
  }
  parts.push(name);
  return parts.join('::');
}

/**
   * Build an ExtractorContext for passing to language-specific visitNode hooks.
   */
export function makeExtractorContext(this: TreeSitterState): ExtractorContext {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const self = this;
  return {
    createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
    visitNode: (node) => self.visitNode(node),
    visitFunctionBody: (body, functionId) => self.visitFunctionBody(body, functionId),
    addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
    pushScope: (nodeId) => self.nodeStack.push(nodeId),
    popScope: () => self.nodeStack.pop(),
    get filePath() { return self.filePath; },
    get source() { return self.source; },
    get nodeStack() { return self.nodeStack; },
    get nodes() { return self.nodes; },
  };
}

/**
   * Find a previously-extracted node by name (used for back-references like impl blocks)
   */
export function findNodeByName(this: TreeSitterState, name: string): string | undefined {
  for (const node of this.nodes) {
    if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
      return node.id;
    }
  }
  return undefined;
}
