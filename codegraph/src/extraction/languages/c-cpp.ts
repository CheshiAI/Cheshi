import type { Node as SyntaxNode } from '../../web-tree-sitter';
import type { LanguageExtractor } from '../tree-sitter-types';
import { preParseCppSource, preParseCSource } from './c-family-preparse';
import {
  extractCIncludeImport,
  extractCppQualifiedMethodName,
  extractCppReceiverType,
  extractCppReturnType,
  resolveCFamilyTypeAliasKind,
} from './cpp-declarators';
import { isMacroMisparsedTypeDecl, recoverMangledCppName } from './cpp-macros';

export { normalizeCppReturnType } from './cpp-declarators';

export { stripCppTemplateArgs } from './cpp-declarators';

export { resolveCFamilyTypeAliasKind } from './cpp-declarators';

export { extractCIncludeImport } from './cpp-declarators';

export { blankCppExportMacros } from './cpp-macros';

export { blankCppInlineMacros } from './cpp-macros';

export { recoverMangledCppName } from './cpp-macros';

export { blankMetalAttributes } from './cpp-macros';

export { blankCppAnnotationMacroCalls } from './cpp-macros';

export { blankLoneMacroLines } from './cpp-macros';

export { blankCppApiPrefixMacros } from './cpp-macros';

export { blankCppInlineAnnotationMacros } from './cpp-macros';

export { blankCudaConstructs } from './cpp-macros';

export { blankCLeadingAttrMacros } from './c-attributes';

export { blankCCplusplusGuardBodies } from './c-attributes';

export { blankCStatementMacroCalls } from './c-attributes';

export { blankCSandwichedAnnotations } from './c-attributes';

export { blankCAutoInference } from './c-attributes';

export { blankCTrailingParamAttrMacros } from './c-attributes';

export { blankCKernelAnnotations } from './c-declaration-macros';

export { blankCParameterizedAnnotationMacros } from './c-declaration-macros';

export { blankCTypeKeywordArgs } from './c-declaration-macros';

export { blankCFileScopePrefixedDeclMacros } from './c-declaration-macros';

export { rewriteCPrefixedDeclMacroInitializers } from './c-declaration-macros';

export { blankCVaArgQualifiedTypeArgs } from './c-declaration-macros';

export { blankCNamedVariadicDefineDots } from './c-declaration-macros';

export const cExtractor: LanguageExtractor = {
  // CUDA in C-detected headers (content-gated blank; see preParseCSource).
  preParse: preParseCSource,
  // Universal net: recover a real name from any macro-mangled function name.
  recoverMangledName: recoverMangledCppName,
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  // A `const`/`static const` file-scope declaration carries a `type_qualifier`
  // child reading "const" — extract those as `constant`, plain globals as
  // `variable`.
  isConst: (node) =>
    node.namedChildren.some(
      (c: SyntaxNode) => c.type === 'type_qualifier' && c.text === 'const'
    ),
  getReturnType: extractCppReturnType,
  resolveTypeAliasKind: (node) => resolveCFamilyTypeAliasKind(node),
  extractImport: (node, source) => extractCIncludeImport(node, source),
};

export const cppExtractor: LanguageExtractor = {
  // Recover macro-annotated class/struct definitions (`class MYMODULE_API Foo : Base`,
  // #1061/#946) and macro-prefixed functions (`FORCEINLINE FString Foo()`, #1093
  // follow-up) that tree-sitter otherwise misparses.
  preParse: preParseCppSource,
  // Universal net for any macro the curated blank list misses.
  recoverMangledName: recoverMangledCppName,
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  // A bodiless `class_specifier` is a forward declaration (`class Foo;`) or an
  // elaborated type reference, not a definition. Skip it so dozens of forward
  // decls across headers don't mint phantom `class` nodes that crowd out — and
  // get picked as the blast-radius representative over — the single real
  // definition, exactly as bodiless struct/enum specifiers are already skipped. (#1093)
  skipBodilessClass: true,
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: extractCppQualifiedMethodName,
  getReceiverType: extractCppReceiverType,
  getReturnType: extractCppReturnType,
  getVisibility: (node) => {
    // Check for access specifier in parent
    const parent = node.parent;
    if (parent) {
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child?.type === 'access_specifier') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
        }
      }
    }
    return undefined;
  },
  resolveTypeAliasKind: (node) => resolveCFamilyTypeAliasKind(node),
  isMisparsedFunction: (name, node) => {
    // C++ macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause tree-sitter to misparse
    // namespace blocks as function_definitions (e.g. name = "namespace detail").
    // Also filter C++ keywords that tree-sitter occasionally misinterprets as
    // function/method names (e.g. switch statements inside macro-confused scopes).
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    // `class MACRO Name : public Base { … }` misparses to a function_definition
    // named after the class. `blankCppExportMacros` (preParse) recovers the
    // common ALL-CAPS export-macro shape; this drop is the fallback for any
    // residual misparse it doesn't blank — still no phantom function (#1061/#946).
    return isMacroMisparsedTypeDecl(node);
  },
  extractImport: (node, source) => extractCIncludeImport(node, source),
};
