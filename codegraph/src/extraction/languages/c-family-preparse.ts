import {
  blankCAutoInference,
  blankCCplusplusGuardBodies,
  blankCLeadingAttrMacros,
  blankCSandwichedAnnotations,
  blankCStatementMacroCalls,
  blankCTrailingParamAttrMacros,
} from './c-attributes';
import {
  blankCFileScopePrefixedDeclMacros,
  blankCKernelAnnotations,
  blankCNamedVariadicDefineDots,
  blankCParameterizedAnnotationMacros,
  blankCTypeKeywordArgs,
  blankCVaArgQualifiedTypeArgs,
  rewriteCPrefixedDeclMacroInitializers,
} from './c-declaration-macros';
import {
  blankCppAnnotationMacroCalls,
  blankCppApiPrefixMacros,
  blankCppExportMacros,
  blankCppInlineAnnotationMacros,
  blankCppInlineMacros,
  blankCudaConstructs,
  blankLoneMacroLines,
  blankMetalAttributes,
  looksLikeCudaSource,
} from './cpp-macros';

/**
 * Restore preprocessor-directive lines to their original bytes after the
 * blanking passes ran. The token-level blanks match on shape, not context, so
 * a macro name that happens to sit inside a DIRECTIVE gets blanked too — and
 * blanking the name position of `#define FMT_API FMT_VISIBILITY("default")`
 * leaves a nameless `#  define        FMT_VISIBILITY(…)`, which is a parse
 * ERROR (fmt's base.h carries several). Inside a directive the blanks were
 * never useful anyway: tree-sitter stores `#define` bodies as raw
 * preproc_arg text it doesn't parse, so blanking there can only ever break
 * the directive itself. Copying the original directive lines back (including
 * `\`-continuation lines of multi-line defines) is offset-preserving by
 * construction and strictly reduces parse errors on both extraction arms.
 */
function restoreDirectiveLines(original: string, blanked: string): string {
  if (blanked === original || original.indexOf('#') === -1) return blanked;
  const o = original.split('\n');
  const b = blanked.split('\n');
  let changed = false;
  let continuation: boolean = false;
  for (let i = 0; i < o.length && i < b.length; i++) {
    const line = o[i] as string;
    const isDirective: boolean = continuation || /^[ \t]*#/.test(line);
    if (isDirective && b[i] !== line) {
      b[i] = line;
      changed = true;
    }
    continuation = isDirective && /\\\s*$/.test(line.replace(/\r$/, ''));
  }
  return changed ? b.join('\n') : blanked;
}

/** C/C++ source pre-processing before tree-sitter: recover macro-annotated class
 * definitions, macro-prefixed function definitions, macro-prefixed members, and
 * macro-decorated members (Unreal-Engine reflection markup) — plus the non-C++
 * surface of the dialects parsed with the C++ grammar: `.metal` MSL attribute
 * annotations, and CUDA specifiers + launch syntax (by `.cu`/`.cuh` extension
 * or by content, for CUDA living in `.h`/`.hpp` headers). Offset-preserving;
 * directive lines are restored at the end (see restoreDirectiveLines). */
export function preParseCppSource(source: string, filePath?: string): string {
  // blankCLeadingAttrMacros runs AFTER the api-prefix blank so a stacked
  // `FMT_NORETURN FMT_API void f(…)` reduces to the `MACRO Ret name(` shape
  // it matches (the _API token is already spaces by then).
  let blanked = blankLoneMacroLines(
    blankCLeadingAttrMacros(
      blankCppAnnotationMacroCalls(
        blankCppInlineAnnotationMacros(
          blankCppApiPrefixMacros(blankCppInlineMacros(blankCppExportMacros(source)))
        )
      )
    )
  );
  const lower = filePath ? filePath.toLowerCase() : '';
  if (lower.endsWith('.metal')) {
    blanked = blankMetalAttributes(blanked);
  } else if (lower.endsWith('.cu') || lower.endsWith('.cuh') || looksLikeCudaSource(source)) {
    blanked = blankCudaConstructs(blanked);
  }
  return restoreDirectiveLines(source, blanked);
}

/** C source pre-processing: neutralize `#ifdef __cplusplus` compat-guard
 * bodies (invisible to a C compiler; `extern "C" {` otherwise errors every
 * public header), blank declaration-markup macro calls and lone macro lines
 * (`REDIS_NO_SANITIZE("bounds")` before a definition, jemalloc's diagnostic
 * toggles — the same structural shapes the C++ side already blanks), recover
 * functions hidden behind a leading attribute macro (#1211), then — for
 * C-detected headers in CUDA projects (llm.c keeps `__device__` helpers and
 * kernel prototypes in plain `.h`) — the same content-gated CUDA blank as
 * C++. Offset-preserving. */
export function preParseCSource(source: string): string {
  const inner = blankCKernelAnnotations(blankCCplusplusGuardBodies(source));
  let blanked = blankCLeadingAttrMacros(
    blankLoneMacroLines(
      blankCStatementMacroCalls(
        blankCTrailingParamAttrMacros(
          blankCppAnnotationMacroCalls(
            rewriteCPrefixedDeclMacroInitializers(
              blankCFileScopePrefixedDeclMacros(
                blankCVaArgQualifiedTypeArgs(
                  blankCTypeKeywordArgs(
                    blankCParameterizedAnnotationMacros(
                      blankCAutoInference(blankCSandwichedAnnotations(inner))
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  );
  if (looksLikeCudaSource(blanked)) blanked = blankCudaConstructs(blanked);
  // The named-variadic `#define` pass runs AFTER the directive restore — it
  // deliberately edits directive lines (see its doc comment).
  return blankCNamedVariadicDefineDots(restoreDirectiveLines(source, blanked));
}
