import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerFileNodeExtractionTests(): void {


  describe('File Node Extraction', () => {
    it('should create a file-kind node for each parsed file', () => {
      const code = `
export function greet(name: string): string {
  return "Hello " + name;
}
`;
      const result = extractFromSource('greeter.ts', code);

      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();
      expect(fileNode?.name).toBe('greeter.ts');
      expect(fileNode?.filePath).toBe('greeter.ts');
      expect(fileNode?.language).toBe('typescript');
      expect(fileNode?.startLine).toBe(1);
    });

    it('should create file nodes for Python files', () => {
      const code = `
def main():
    pass
`;
      const result = extractFromSource('main.py', code);

      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();
      expect(fileNode?.name).toBe('main.py');
      expect(fileNode?.language).toBe('python');
    });

    it('should create containment edges from file node to top-level declarations', () => {
      const code = `
export function foo() {}
export function bar() {}
`;
      const result = extractFromSource('fns.ts', code);

      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();

      // There should be contains edges from the file node to each function
      const containsEdges = result.edges.filter(
        (e) => e.source === fileNode?.id && e.kind === 'contains'
      );
      expect(containsEdges.length).toBeGreaterThanOrEqual(2);
    });
  });
}
