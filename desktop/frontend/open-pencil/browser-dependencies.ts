import type { Plugin } from 'vite';

const cssomExports = [
  'setup', 'CSSStyleDeclaration', 'CSSRule', 'CSSRuleList', 'CSSNestedDeclarations',
  'CSSGroupingRule', 'CSSCounterStyleRule', 'CSSPropertyRule', 'CSSConditionRule',
  'CSSStyleRule', 'MediaList', 'CSSMediaRule', 'CSSContainerRule', 'CSSSupportsRule',
  'CSSImportRule', 'CSSNamespaceRule', 'CSSFontFaceRule', 'CSSHostRule', 'CSSStartingStyleRule',
  'StyleSheet', 'CSSStyleSheet', 'CSSKeyframesRule', 'CSSKeyframeRule', 'MatcherList',
  'CSSDocumentRule', 'CSSValue', 'CSSValueExpression', 'CSSScopeRule', 'CSSLayerBlockRule',
  'CSSLayerStatementRule', 'CSSPageRule', 'parse', 'clone',
];

/** Adapt browser dependencies without changing installed packages or filtering diagnostics. */
export function browserDependencies(): Plugin {
  return {
    name: 'cheshi-browser-dependencies',
    enforce: 'pre',
    transform(source, id) {
      const file = id.replaceAll('\\', '/').split('?')[0]!;
      let code = source;
      if (/\/node_modules\/lucide-react\/dist\/esm\/(?:context|Icon)\.mjs$/.test(file)) {
        // Both applications are browser clients; this React Server Components
        // boundary is redundant here. Preserve "use strict" and the license.
        code = code.replace(/^"use client";\r?\n/m, '');
      } else if (/\/node_modules\/zod\/v4\/core\/(?:util|regexes)\.js$/.test(file)) {
        // The prose quotes the annotation syntax. Actual call annotations must
        // remain intact so Rollup can still remove unused schemas.
        code = code.replaceAll('`@__PURE__`', '`PURE`');
      } else if (file.endsWith('/node_modules/@acemir/cssom/build/CSSOM.js')) {
        // CSSOM already checks the stylesheet's realm first. Resolve the final
        // native constructor directly, including in workers without window.
        code = code.replace('eval(errorType)', 'globalThis[errorType]');
        // Its browser entry is a script global, while consumers import it as a
        // module. Expose the same API as the package's Node entry as real ESM.
        code += `\nexport default CSSOM;\nexport const { ${cssomExports.join(', ')} } = CSSOM;\n`;
      }
      return code === source ? null : { code, map: null };
    },
  };
}
