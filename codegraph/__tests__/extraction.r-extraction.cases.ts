import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerRExtractionTests(): void {


  describe('R Extraction', () => {
    describe('Language detection', () => {
      it('should detect R files (both extension cases)', () => {
        expect(detectLanguage('analysis.R')).toBe('r');
        expect(detectLanguage('scripts/clean.r')).toBe('r');
      });

      it('should report R as supported', () => {
        expect(isLanguageSupported('r')).toBe(true);
        expect(getSupportedLanguages()).toContain('r');
      });
    });

    describe('Function extraction', () => {
      it('extracts every assignment form, lambdas, and nested functions', () => {
        const code = /* language=TEXT */ `
clean_data <- function(df, threshold = 0.5) {
  helper <- function(d) scale(d)
  helper(df)
}
normalize = function(v) (v - mean(v)) / sd(v)
double_it <- \\(x) x * 2
`;
        const result = extractFromSource('analysis.R', code);
        const funcs = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
        expect(funcs).toContain('clean_data');
        expect(funcs).toContain('normalize');
        expect(funcs).toContain('double_it');
        expect(funcs).toContain('helper'); // nested, inside clean_data's scope
        const cleanData = result.nodes.find((n) => n.name === 'clean_data');
        expect(cleanData?.language).toBe('r');
        expect(cleanData?.signature).toBe('(df, threshold = 0.5)');
      });

      it('attributes body calls to the enclosing function', () => {
        const code = /* language=TEXT */ `
prep <- function(d) scale(d)
fit_model <- function(data) {
  lm(y ~ x, data = prep(data))
}
`;
        const result = extractFromSource('models.R', code);
        const prepCall = result.unresolvedReferences.find(
          (r) => r.referenceName === 'prep' && r.referenceKind === 'calls'
        );
        expect(prepCall).toBeDefined();
        const fitModel = result.nodes.find((n) => n.name === 'fit_model');
        expect(prepCall?.fromNodeId).toBe(fitModel?.id);
      });
    });

    describe('Imports', () => {
      it('extracts library/require/source as imports, not calls', () => {
        const code = /* language=TEXT */ `
library(dplyr)
require(stats)
requireNamespace("jsonlite")
source("helpers.R")
`;
        const result = extractFromSource('main.R', code);
        const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
        expect(imports).toContain('dplyr');
        expect(imports).toContain('stats');
        expect(imports).toContain('jsonlite');
        expect(imports).toContain('helpers.R');
        // Claimed by the hook — no call references to the import machinery.
        const libCalls = result.unresolvedReferences.filter(
          (r) => r.referenceKind === 'calls' && (r.referenceName === 'library' || r.referenceName === 'source')
        );
        expect(libCalls).toHaveLength(0);
      });
    });

    describe('Variables and constants', () => {
      it('extracts top-level assignments; ALL_CAPS as constants; right-assign too', () => {
        const code = /* language=TEXT */ `
ALPHA <- 0.05
max_iter = 100
compute_stats(df) -> stats_result
inner <- function() {
  local_var <- 1
}
`;
        const result = extractFromSource('config.R', code);
        const constant = result.nodes.find((n) => n.name === 'ALPHA');
        expect(constant?.kind).toBe('constant');
        const variable = result.nodes.find((n) => n.name === 'max_iter');
        expect(variable?.kind).toBe('variable');
        const rightAssigned = result.nodes.find((n) => n.name === 'stats_result');
        expect(rightAssigned?.kind).toBe('variable');
        // Locals inside functions are deliberately NOT extracted.
        expect(result.nodes.find((n) => n.name === 'local_var')).toBeUndefined();
      });
    });

    describe('Classes', () => {
      it('extracts S4/R5/R6 class calls as classes with their list methods', () => {
        const code = /* language=TEXT */ `
setClass("Patient", representation(id = "character"))
Account <- setRefClass("Account",
  fields = list(balance = "numeric"),
  methods = list(deposit = function(x) { balance <<- balance + x })
)
Stack <- R6Class("Stack",
  public = list(push = function(v) invisible(v))
)
setGeneric("describe", function(obj) standardGeneric("describe"))
setMethod("describe", "Patient", function(obj) paste(obj@id))
`;
        const result = extractFromSource('classes.R', code);
        const classes = result.nodes.filter((n) => n.kind === 'class').map((n) => n.name);
        expect(classes).toContain('Patient');
        expect(classes).toContain('Account');
        expect(classes).toContain('Stack');
        const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
        expect(methods).toContain('deposit');
        expect(methods).toContain('push');
        // setGeneric/setMethod produce functions named by their string argument.
        const describes = result.nodes.filter((n) => n.name === 'describe' && n.kind === 'function');
        expect(describes.length).toBeGreaterThanOrEqual(2);
        // The class-assignment idiom must not ALSO produce a variable node.
        expect(result.nodes.find((n) => n.name === 'Account' && n.kind === 'variable')).toBeUndefined();
      });

      it('extracts ggproto classes with direct-arg methods and the parent as extends', () => {
        // ggplot2's OO system — every Geom/Stat/Scale in the ecosystem uses it.
        const code = /* language=TEXT */ `
GeomPoint <- ggproto("GeomPoint", Geom,
  required_aes = c("x", "y"),
  draw_panel = function(data, panel_params, coord) {
    coords <- coord$transform(data, panel_params)
    grid::pointsGrob(coords$x, coords$y)
  },
  draw_key = draw_key_point
)
`;
        const result = extractFromSource('geom-point.R', code);
        const cls = result.nodes.find((n) => n.name === 'GeomPoint' && n.kind === 'class');
        expect(cls).toBeDefined();
        const method = result.nodes.find((n) => n.name === 'draw_panel' && n.kind === 'method');
        expect(method).toBeDefined();
        const ext = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'Geom'
        );
        expect(ext?.fromNodeId).toBe(cls?.id);
        // No twin variable for the assignment.
        expect(result.nodes.find((n) => n.name === 'GeomPoint' && n.kind === 'variable')).toBeUndefined();
      });
    });
  });
}
