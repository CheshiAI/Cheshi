import { extractFromSource } from '../src/extraction';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerRegressionIssueSpecificExtractionFixesTests(): void {


  describe('Regression: issue-specific extraction fixes', () => {
    it('indexes inner functions of an anonymous AMD/CommonJS module wrapper (#528)', () => {
      const code = `
define(['dep'], function (dep) {
  function innerHelper(x) { return x + 1; }
  function compute(y) { return innerHelper(y); }
  return { compute: compute };
});
`;
      const result = extractFromSource('amd-module.js', code);
      const fns = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(fns).toContain('innerHelper');
      expect(fns).toContain('compute');
    });

    it('attaches Go methods on generic receivers to their type (#583)', () => {
      const code = `
package main

type Stack[T any] struct { items []T }

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }
func (s Stack[T]) Len() int { return len(s.items) }
`;
      const result = extractFromSource('stack.go', code);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.find((m) => m.name === 'Push')?.qualifiedName).toBe('Stack::Push');
      expect(methods.find((m) => m.name === 'Len')?.qualifiedName).toBe('Stack::Len');
    });

    it('indexes new module extensions: .mts/.cts (TS) and .xsjs/.xsjslib (JS) (#366, #556)', () => {
      expect(isSourceFile('mod.mts')).toBe(true);
      expect(isSourceFile('mod.cts')).toBe(true);
      expect(isSourceFile('service.xsjs')).toBe(true);
      expect(isSourceFile('lib.xsjslib')).toBe(true);
      expect(detectLanguage('mod.mts')).toBe('typescript');
      expect(detectLanguage('service.xsjs')).toBe('javascript');

      // End-to-end: a .mts file is parsed as TS, a .xsjs file as JS.
      const ts = extractFromSource('mod.mts', 'export function hello(): number { return 1; }');
      expect(ts.nodes.find((n) => n.name === 'hello' && n.kind === 'function')).toBeDefined();
      const js = extractFromSource('service.xsjs', 'function handleRequest() { return 1; }');
      expect(js.nodes.find((n) => n.name === 'handleRequest' && n.kind === 'function')).toBeDefined();
    });
  });
}
