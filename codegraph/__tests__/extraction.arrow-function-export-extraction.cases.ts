import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerArrowFunctionExportExtractionTests(): void {


  describe('Arrow Function Export Extraction', () => {
    it('should extract exported arrow functions assigned to const', () => {
      const code = `
export const useAuth = (): AuthContextValue => {
  return useContext(AuthContext);
};
`;
      const result = extractFromSource('hooks.ts', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
      expect(funcNode).toBeDefined();
      expect(funcNode).toMatchObject({
        kind: 'function',
        name: 'useAuth',
        isExported: true,
      });
    });

    it('should extract exported function expressions assigned to const', () => {
      const code = `
export const processData = function(input: string): string {
  return input.trim();
};
`;
      const result = extractFromSource('utils.ts', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
      expect(funcNode).toBeDefined();
      expect(funcNode).toMatchObject({
        kind: 'function',
        name: 'processData',
        isExported: true,
      });
    });

    it('should not extract non-exported arrow functions as exported', () => {
      const code = `
const internalHelper = () => {
  return 42;
};
`;
      const result = extractFromSource('internal.ts', code);

      const helperNode = result.nodes.find((n) => n.name === 'internalHelper');
      expect(helperNode).toBeDefined();
      expect(helperNode?.isExported).toBeFalsy();
    });

    it('should still skip truly anonymous arrow functions', () => {
      const code = `
const items = [1, 2, 3].map((x) => x * 2);
`;
      const result = extractFromSource('anon.ts', code);

      // The inline arrow function passed to .map() has no variable_declarator parent
      // and should remain anonymous (skipped)
      const anonFunctions = result.nodes.filter(
        (n) => n.kind === 'function' && n.name === '<anonymous>'
      );
      expect(anonFunctions).toHaveLength(0);
    });

    it('should extract multiple exported arrow functions from the same file', () => {
      const code = `
export const add = (a: number, b: number): number => a + b;

export const subtract = (a: number, b: number): number => a - b;

const internal = () => 'not exported';
`;
      const result = extractFromSource('math.ts', code);

      const exported = result.nodes.filter((n) => n.kind === 'function' && n.isExported);
      expect(exported).toHaveLength(2);
      expect(exported.map((n) => n.name).sort()).toEqual(['add', 'subtract']);

      const internalNode = result.nodes.find((n) => n.name === 'internal');
      expect(internalNode).toBeDefined();
      expect(internalNode?.isExported).toBeFalsy();
    });

    it('should extract arrow functions in JavaScript files', () => {
      const code = `
export const fetchData = async () => {
  const response = await fetch('/api/data');
  return response.json();
};
`;
      const result = extractFromSource('api.js', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'fetchData');
      expect(funcNode).toBeDefined();
      expect(funcNode).toMatchObject({
        kind: 'function',
        name: 'fetchData',
        isExported: true,
      });
    });
  });
}
