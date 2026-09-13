import { getAllFrameworkResolvers, getApplicableFrameworks } from '../resolution/frameworks';
import { TreeSitterState } from './tree-sitter-state';
import {
  ExtractionResult,
  Language
} from '../types';
import { AstroExtractor } from './astro-extractor';
import { CfmlExtractor } from './cfml-extractor';
import { DfmExtractor } from './dfm-extractor';
import { detectLanguage, isFileLevelOnlyLanguage } from './grammars';
import { takeDeferredPreParse, tryKernelExtract } from './kernel';
import { LiquidExtractor } from './liquid-extractor';
import { MyBatisExtractor } from './mybatis-extractor';
import { RazorExtractor } from './razor-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { VueExtractor } from './vue-extractor';
import * as path from 'path';

export { generateNodeId } from './tree-sitter-helpers';

export class TreeSitterExtractor {
  private readonly state: TreeSitterState;

  constructor(filePath: string, source: string, language?: Language, options?: { sourceIsPreParsed?: boolean }) {
    this.state = new TreeSitterState(filePath, source, language, options, this);
  }

  extract(): ExtractionResult {
    return this.state.extract();
  }
}

/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language are run after the tree-sitter pass.
 * Their nodes/references/errors are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  let result: ExtractionResult;

  // Use custom extractor for Svelte
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    // Use custom extractor for Vue
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'astro') {
    // Use custom extractor for Astro (frontmatter + template delegation)
    const extractor = new AstroExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    // Use custom extractor for Liquid
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'razor') {
    // Use custom extractor for ASP.NET Razor (.cshtml) / Blazor (.razor) markup
    const extractor = new RazorExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'xml') {
    // Custom extractor for MyBatis mapper XML. Non-mapper XML returns just a
    // file node so the watcher tracks it without emitting symbols.
    const extractor = new MyBatisExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'cfml' || detectedLanguage === 'cfscript') {
    // Custom extractor for CFML (.cfc/.cfm) — dialect-switches between the
    // tag-based cfml grammar and the bare-script cfscript grammar. Standalone
    // `.cfs` files (language 'cfscript') are always pure script (never `<`-led),
    // so routing them through here too gets them the same anonymous-component
    // filename fallback as a bare-script `.cfc` — without it a `.cfs` whose
    // `component { ... }` declares no name (the grammar has no `name` field;
    // CFML never spells one in source) stays `<anonymous>`.
    const extractor = new CfmlExtractor(filePath, source, detectedLanguage);
    result = extractor.extract();
  } else if (isFileLevelOnlyLanguage(detectedLanguage)) {
    // No symbol extraction at this stage — files are tracked at the file-record
    // level only. Framework extractors (Drupal routing yml, Spring `@Value`
    // resolution against application.yml/application.properties) run later and
    // add per-file nodes/references when they apply.
    result = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    // Use custom extractor for DFM/FMX form files
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    // Native-kernel route: gated per language, null when not routed/available
    // or on a kernel error —
    // the wasm TreeSitterExtractor below stays the fallback either way.
    const kernelResult = tryKernelExtract(filePath, source, detectedLanguage);
    if (kernelResult) {
      result = kernelResult;
    } else {
      // A kernel-deferred file already paid the (offset-preserving) preParse
      // at the route point — reuse those bytes instead of blanking again.
      const deferredPre = takeDeferredPreParse(filePath, source, detectedLanguage);
      const extractor = new TreeSitterExtractor(
        filePath,
        deferredPre ?? source,
        detectedLanguage,
        { sourceIsPreParsed: deferredPre != null }
      );
      result = extractor.extract();
    }
  }

  // Framework-specific extraction (routes, middleware, etc.)
  if (frameworkNames && frameworkNames.length > 0) {
    const allResolvers = getAllFrameworkResolvers();
    const applicable = getApplicableFrameworks(
      allResolvers.filter((r) => frameworkNames.includes(r.name)),
      detectedLanguage
    );
    for (const fw of applicable) {
      if (!fw.extract) continue;
      try {
        const fwResult = fw.extract(filePath, source);
        result.nodes.push(...fwResult.nodes);
        result.unresolvedReferences.push(...fwResult.references);
      } catch (err) {
        result.errors.push({
          message: `Framework extractor '${fw.name}' failed: ${err instanceof Error ? err.message : String(err)
            }`,
          filePath,
          severity: 'warning',
        });
      }
    }
  }

  return result;
}
