import {
  Edge,
  ExtractionError,
  Language,
  Node,
  UnresolvedReference
} from '../types';
import type { Node as SyntaxNode, Tree } from '../web-tree-sitter';
import { FN_REF_SPECS, type FnRefCandidate, type FnRefSpec } from './function-ref';
import { detectLanguage } from './grammars';
import { EXTRACTORS } from './languages';
import type { TreeSitterExtractor } from './tree-sitter';
import {
  extractAnonymousClass,
  extractInstantiation,
  extractStaticMemberRef,
  findAnonymousClassBody,
  isCppStackConstruction,
  isVbnetConstructorShapedArrayCreation,
  pushStaticMemberRef,
  resolveErlangGenServerTarget,
} from './tree-sitter-call-receivers';
import { extractCall } from './tree-sitter-calls';
import {
  extractClass,
  extractEnum,
  extractEnumMembers,
  extractField,
  extractFunction,
  extractInterface,
  extractMethod,
  extractProperty,
  extractReactComponentNode,
  extractStruct,
  isClassScopeConstantAssignment,
  isInsideClassLikeNode,
  reactComponentHoc,
} from './tree-sitter-declarations';
import { extractDecoratorsFor, extractRustRouteMacro } from './tree-sitter-decorators';
import {
  emitImportBindingRefs,
  emitPhpUseRefs,
  emitPyFromImportRefs,
  emitReExportRefs,
  emitRubyRequireRefs,
  emitRustUseBindingRefs,
  extractImport,
  pushPhpUseRef,
} from './tree-sitter-imports';
import { extractInheritance, extractRustImplItem } from './tree-sitter-inheritance';
import {
  extractPascalCall,
  extractPascalConst,
  extractPascalDeclType,
  extractPascalDefProc,
  extractPascalInheritance,
  extractPascalParenlessCall,
  extractPascalUses,
  visitPascalBlock,
  visitPascalNode,
} from './tree-sitter-pascal';
import {
  buildQualifiedName,
  composeReceiverQualifiedName,
  createNode,
  extract,
  extractFilePackage,
  findChildByTypes,
  findNodeByName,
  makeExtractorContext,
} from './tree-sitter-runtime';
import { recordCppFnPtrBinding, visitFunctionBody, visitNode } from './tree-sitter-traversal';
import {
  extractGoInterfaceMethods,
  extractTsTupleContractNames,
  extractTsTypeAliasMembers,
  extractTypeAlias,
  isTsFunctionTypedProperty,
} from './tree-sitter-type-declarations';
import {
  extractCsharpPrimaryCtorParamRefs,
  extractCsharpTypeRefs,
  extractPhpTypeRefs,
  extractTypeAnnotations,
  extractTypeRefsFromSubtree,
  extractVariableTypeAnnotation,
  walkCsharpTypePosition,
  walkPhpTypePosition,
} from './tree-sitter-type-refs';
import type { LanguageExtractor } from './tree-sitter-types';
import {
  captureValueRefScope,
  flushFnRefCandidates,
  flushValueRefs,
  maybeCaptureFnRefs,
  scanFnRefSubtree,
} from './tree-sitter-value-refs';
import {
  extractObjectLiteralFunctions,
  extractPiniaSetupBody,
  extractRtkEndpoints,
  extractRtkHookBindings,
  extractStoreCollectionMethods,
  extractVariable,
  findInitializerReturnedObject,
  findPiniaSetupFn,
  findRtkEndpointsObject,
  findVueStoreCollectionObjects,
  functionReturnedObject,
  looksLikeVueStoreFile,
  objectHasInlineFunctions,
  objectKeyName,
  rtkEndpointHandler,
} from './tree-sitter-variables';

/** Internal state and method bindings for TreeSitterExtractor. */
export class TreeSitterState {
  readonly filePath: string;

  readonly language: Language;

  source: string;

  tree: Tree | null = null;

  nodes: Node[] = [];

  edges: Edge[] = [];

  unresolvedReferences: UnresolvedReference[] = [];

  readonly valueRefsEnabled = process.env.CODEGRAPH_VALUE_REFS !== '0';

  fileScopeValues = new Map<string, string>();

  fileScopeValueCounts = new Map<string, number>();

  // file-scope nodes per name (conditional-def detection)
  valueRefScopes: Array<{ id: string; node: SyntaxNode; name: string }> = [];

  errors: ExtractionError[] = [];

  readonly extractor: LanguageExtractor | null = null;

  nodeStack: string[] = [];

  // Stack of parent node IDs
  // C/C++ enclosing `namespace ns { … }` names, prepended to every contained
  // symbol's qualifiedName (see visitNode). Prefix-only by design — no
  // namespace NODE is created: `namespace cutlass {` opens in thousands of
  // files, and a node per block would flood search with same-named symbols
  // (the #1093 crowd-out failure mode). Always empty outside C/C++.
  namespacePrefix: string[] = [];

  // C++ local function-pointer bindings, per enclosing symbol:
  // `auto kernel = &flash_fwd_kernel<…>;` recorded as callerId → kernel →
  // {flash_fwd_kernel}, so a later `kernel<<<grid, block>>>(params)` (or plain
  // `kernel(args)`) in the same body emits calls refs to the real target(s)
  // instead of an unresolvable local name. Branch reassignments accumulate —
  // each assigned target is a genuine possible callee. Same-body locality is
  // the precision guard (the #932 table-dispatch philosophy scoped to locals).
  readonly cppLocalFnPtrs = new Map<string, Map<string, Set<string>>>();

  methodIndex: Map<string, string> | null = null;

  // lookup key → node ID for Pascal defProc lookup
  // Function-as-value capture (#756): per-language spec + candidates collected
  // during the walk, gated & flushed into unresolvedReferences at end-of-file
  // (see flushFnRefCandidates).
  readonly fnRefSpec: FnRefSpec | undefined;

  fnRefCandidates: Array<FnRefCandidate & { fromNodeId: string }> = [];

  // Memoized "is this a Vue store file" verdict (per-extractor = per-file).
  vueStoreFile: boolean | null = null;

  // Source already went through the extractor's preParse at the kernel route
  // point (this instance is the wasm fallback for a kernel-deferred file) —
  // don't blank it a second time.
  readonly sourceIsPreParsed: boolean = false;

  constructor(filePath: string, source: string, language?: Language, options?: { sourceIsPreParsed?: boolean }, readonly owner: Pick<TreeSitterExtractor, keyof TreeSitterExtractor> = this) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
    this.fnRefSpec = FN_REF_SPECS[this.language];
    this.sourceIsPreParsed = options?.sourceIsPreParsed === true;
  }

  /**
   * Extract a function call
   */
  /**
   * The module an Erlang gen_server target expression statically names, or
   * null when it's dynamic (pid/var/tuple form). Static shapes:
   *   - a bare atom — either this module or another one; OTP's dominant
   *     registration convention (`{local, ?MODULE}`) names a server process
   *     after its module, so `gen_server:call(other_mod, …)` reaches
   *     `other_mod`'s handlers. A registered name that matches no module
   *     resolves to nothing downstream (the qualified ref just drops).
   *   - `?MODULE`, or a macro the file defines as `?MODULE`
   *     (`-define(SERVER, ?MODULE)` — the standard self idiom)
   *   - a macro the file defines as a bare atom
   *     (`-define(STORE, kv_store)` — the cross-module variant)
   * The macro tables are memoized per file (single entry — extraction is
   * file-sequential).
   */
  erlangServerMacroFile = '';

  erlangSelfMacros = new Set<string>();

  erlangAtomMacros = new Map<string, string>();

  /**
   * Languages that support type annotations (TypeScript, etc.)
   */
  readonly TYPE_ANNOTATION_LANGUAGES = new Set([
    'typescript', 'tsx', 'arkts', 'dart', 'kotlin', 'swift', 'rust', 'go', 'java', 'csharp', 'scala', 'php',
  ]);

  /**
   * PHP pseudo-types and `self`/`static`/`parent` that aren't project symbols.
   * (Scalar primitives parse as `primitive_type` and are skipped structurally.)
   */
  readonly PHP_PSEUDO_TYPES = new Set([
    'self', 'static', 'parent', 'mixed', 'object', 'iterable', 'callable', 'void',
    'null', 'false', 'true', 'never', 'array', 'int', 'float', 'string', 'bool',
  ]);

  /**
   * Built-in/primitive type names that shouldn't create references
   */
  readonly BUILTIN_TYPES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
    'object', 'symbol', 'bigint', 'true', 'false',
    // Rust
    'str', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'char',
    // Java/C#
    'int', 'long', 'short', 'byte', 'float', 'double', 'char',
    // Go
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128', 'rune', 'error',
    // Scala (capitalized primitives + ubiquitous stdlib aliases)
    'Int', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean', 'Char', 'Unit',
    'String', 'Any', 'AnyRef', 'AnyVal', 'Nothing', 'Null',
  ]);
}

export interface TreeSitterState {
  extract: typeof extract;
  maybeCaptureFnRefs: typeof maybeCaptureFnRefs;
  scanFnRefSubtree: typeof scanFnRefSubtree;
  flushFnRefCandidates: typeof flushFnRefCandidates;
  captureValueRefScope: typeof captureValueRefScope;
  flushValueRefs: typeof flushValueRefs;
  visitNode: typeof visitNode;
  createNode: typeof createNode;
  findChildByTypes: typeof findChildByTypes;
  extractFilePackage: typeof extractFilePackage;
  composeReceiverQualifiedName: typeof composeReceiverQualifiedName;
  buildQualifiedName: typeof buildQualifiedName;
  makeExtractorContext: typeof makeExtractorContext;
  isInsideClassLikeNode: typeof isInsideClassLikeNode;
  isClassScopeConstantAssignment: typeof isClassScopeConstantAssignment;
  extractFunction: typeof extractFunction;
  reactComponentHoc: typeof reactComponentHoc;
  extractReactComponentNode: typeof extractReactComponentNode;
  extractClass: typeof extractClass;
  extractMethod: typeof extractMethod;
  extractInterface: typeof extractInterface;
  extractStruct: typeof extractStruct;
  extractEnum: typeof extractEnum;
  extractEnumMembers: typeof extractEnumMembers;
  extractProperty: typeof extractProperty;
  extractField: typeof extractField;
  extractObjectLiteralFunctions: typeof extractObjectLiteralFunctions;
  objectKeyName: typeof objectKeyName;
  findInitializerReturnedObject: typeof findInitializerReturnedObject;
  functionReturnedObject: typeof functionReturnedObject;
  findRtkEndpointsObject: typeof findRtkEndpointsObject;
  extractRtkEndpoints: typeof extractRtkEndpoints;
  rtkEndpointHandler: typeof rtkEndpointHandler;
  extractRtkHookBindings: typeof extractRtkHookBindings;
  looksLikeVueStoreFile: typeof looksLikeVueStoreFile;
  objectHasInlineFunctions: typeof objectHasInlineFunctions;
  findVueStoreCollectionObjects: typeof findVueStoreCollectionObjects;
  extractStoreCollectionMethods: typeof extractStoreCollectionMethods;
  findPiniaSetupFn: typeof findPiniaSetupFn;
  extractPiniaSetupBody: typeof extractPiniaSetupBody;
  extractVariable: typeof extractVariable;
  extractTypeAlias: typeof extractTypeAlias;
  extractGoInterfaceMethods: typeof extractGoInterfaceMethods;
  extractTsTypeAliasMembers: typeof extractTsTypeAliasMembers;
  extractTsTupleContractNames: typeof extractTsTupleContractNames;
  isTsFunctionTypedProperty: typeof isTsFunctionTypedProperty;
  extractImport: typeof extractImport;
  emitImportBindingRefs: typeof emitImportBindingRefs;
  emitReExportRefs: typeof emitReExportRefs;
  emitRustUseBindingRefs: typeof emitRustUseBindingRefs;
  emitPhpUseRefs: typeof emitPhpUseRefs;
  emitRubyRequireRefs: typeof emitRubyRequireRefs;
  pushPhpUseRef: typeof pushPhpUseRef;
  emitPyFromImportRefs: typeof emitPyFromImportRefs;
  resolveErlangGenServerTarget: typeof resolveErlangGenServerTarget;
  extractCall: typeof extractCall;
  isVbnetConstructorShapedArrayCreation: typeof isVbnetConstructorShapedArrayCreation;
  extractInstantiation: typeof extractInstantiation;
  isCppStackConstruction: typeof isCppStackConstruction;
  extractStaticMemberRef: typeof extractStaticMemberRef;
  pushStaticMemberRef: typeof pushStaticMemberRef;
  findAnonymousClassBody: typeof findAnonymousClassBody;
  extractAnonymousClass: typeof extractAnonymousClass;
  extractDecoratorsFor: typeof extractDecoratorsFor;
  extractRustRouteMacro: typeof extractRustRouteMacro;
  recordCppFnPtrBinding: typeof recordCppFnPtrBinding;
  visitFunctionBody: typeof visitFunctionBody;
  extractInheritance: typeof extractInheritance;
  extractRustImplItem: typeof extractRustImplItem;
  findNodeByName: typeof findNodeByName;
  extractTypeAnnotations: typeof extractTypeAnnotations;
  extractCsharpTypeRefs: typeof extractCsharpTypeRefs;
  extractCsharpPrimaryCtorParamRefs: typeof extractCsharpPrimaryCtorParamRefs;
  walkCsharpTypePosition: typeof walkCsharpTypePosition;
  extractPhpTypeRefs: typeof extractPhpTypeRefs;
  walkPhpTypePosition: typeof walkPhpTypePosition;
  extractVariableTypeAnnotation: typeof extractVariableTypeAnnotation;
  extractTypeRefsFromSubtree: typeof extractTypeRefsFromSubtree;
  visitPascalNode: typeof visitPascalNode;
  extractPascalDeclType: typeof extractPascalDeclType;
  extractPascalUses: typeof extractPascalUses;
  extractPascalConst: typeof extractPascalConst;
  extractPascalInheritance: typeof extractPascalInheritance;
  extractPascalDefProc: typeof extractPascalDefProc;
  extractPascalCall: typeof extractPascalCall;
  extractPascalParenlessCall: typeof extractPascalParenlessCall;
  visitPascalBlock: typeof visitPascalBlock;
}

Object.assign(TreeSitterState.prototype, {
  extract,
  maybeCaptureFnRefs,
  scanFnRefSubtree,
  flushFnRefCandidates,
  captureValueRefScope,
  flushValueRefs,
  visitNode,
  createNode,
  findChildByTypes,
  extractFilePackage,
  composeReceiverQualifiedName,
  buildQualifiedName,
  makeExtractorContext,
  isInsideClassLikeNode,
  isClassScopeConstantAssignment,
  extractFunction,
  reactComponentHoc,
  extractReactComponentNode,
  extractClass,
  extractMethod,
  extractInterface,
  extractStruct,
  extractEnum,
  extractEnumMembers,
  extractProperty,
  extractField,
  extractObjectLiteralFunctions,
  objectKeyName,
  findInitializerReturnedObject,
  functionReturnedObject,
  findRtkEndpointsObject,
  extractRtkEndpoints,
  rtkEndpointHandler,
  extractRtkHookBindings,
  looksLikeVueStoreFile,
  objectHasInlineFunctions,
  findVueStoreCollectionObjects,
  extractStoreCollectionMethods,
  findPiniaSetupFn,
  extractPiniaSetupBody,
  extractVariable,
  extractTypeAlias,
  extractGoInterfaceMethods,
  extractTsTypeAliasMembers,
  extractTsTupleContractNames,
  isTsFunctionTypedProperty,
  extractImport,
  emitImportBindingRefs,
  emitReExportRefs,
  emitRustUseBindingRefs,
  emitPhpUseRefs,
  emitRubyRequireRefs,
  pushPhpUseRef,
  emitPyFromImportRefs,
  resolveErlangGenServerTarget,
  extractCall,
  isVbnetConstructorShapedArrayCreation,
  extractInstantiation,
  isCppStackConstruction,
  extractStaticMemberRef,
  pushStaticMemberRef,
  findAnonymousClassBody,
  extractAnonymousClass,
  extractDecoratorsFor,
  extractRustRouteMacro,
  recordCppFnPtrBinding,
  visitFunctionBody,
  extractInheritance,
  extractRustImplItem,
  findNodeByName,
  extractTypeAnnotations,
  extractCsharpTypeRefs,
  extractCsharpPrimaryCtorParamRefs,
  walkCsharpTypePosition,
  extractPhpTypeRefs,
  walkPhpTypePosition,
  extractVariableTypeAnnotation,
  extractTypeRefsFromSubtree,
  visitPascalNode,
  extractPascalDeclType,
  extractPascalUses,
  extractPascalConst,
  extractPascalInheritance,
  extractPascalDefProc,
  extractPascalCall,
  extractPascalParenlessCall,
  visitPascalBlock,
});
