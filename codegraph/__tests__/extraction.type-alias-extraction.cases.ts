import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerTypeAliasExtractionTests(): void {


  describe('Type Alias Extraction', () => {
    it('should extract exported type aliases in TypeScript', () => {
      const code = `
export type AuthContextValue = {
  user: User | null;
  login: () => void;
  logout: () => void;
};
`;
      const result = extractFromSource('types.ts', code);

      const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
      expect(typeNode).toMatchObject({
        kind: 'type_alias',
        name: 'AuthContextValue',
        isExported: true,
      });
    });

    it('should extract non-exported type aliases', () => {
      const code = `
type InternalState = {
  loading: boolean;
  error: string | null;
};
`;
      const result = extractFromSource('internal.ts', code);

      const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
      expect(typeNode).toMatchObject({
        kind: 'type_alias',
        name: 'InternalState',
        isExported: false,
      });
    });

    it('should extract multiple type aliases from the same file', () => {
      const code = `
export type UnitSystem = 'metric' | 'imperial';
export type DateFormat = 'ISO' | 'US' | 'EU';
type Internal = string;
`;
      const result = extractFromSource('config.ts', code);

      const typeAliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(typeAliases).toHaveLength(3);

      const exported = typeAliases.filter((n) => n.isExported);
      expect(exported).toHaveLength(2);
      expect(exported.map((n) => n.name).sort()).toEqual(['DateFormat', 'UnitSystem']);
    });

    // A service/contract registry written as a tuple of generic instantiations —
    // the names are string-literal type arguments, not declarations, so static
    // extraction otherwise never indexes them (issue #634).
    it('extracts string-literal contract names from a generic tuple type alias (#634)', () => {
      const code = `
interface Service<Name extends string, Req, Resp> { name: Name; }
export type MyServiceList = [
  Service<'query_apply_record', { pageNo: number }, { ok: boolean }>,
  Service<'apply_confirm', { code: string }, { ok: boolean }>
];
`;
      const result = extractFromSource('services/api.ts', code);

      const names = result.nodes.filter(
        (n) => n.kind === 'method' && n.qualifiedName.startsWith('MyServiceList::')
      );
      expect(names.map((n) => n.name).sort()).toEqual(['apply_confirm', 'query_apply_record']);

      const queryNode = names.find((n) => n.name === 'query_apply_record');
      expect(queryNode?.qualifiedName).toBe('MyServiceList::query_apply_record');
      // Signature carries the full contract entry so search results show context.
      expect(queryNode?.signature).toContain("Service<'query_apply_record'");

      // The string-literal name is contained by the type alias.
      const alias = result.nodes.find((n) => n.kind === 'type_alias' && n.name === 'MyServiceList');
      const containsEdge = result.edges.find(
        (e) => e.kind === 'contains' && e.source === alias?.id && e.target === queryNode?.id
      );
      expect(containsEdge).toBeDefined();
    });

    it('does not extract string literals from utility types or nested generics (#634)', () => {
      const code = `
interface User { id: string; name: string; }
interface Service<Name extends string, Req, Resp> { name: Name; }
export type Picked = Pick<User, 'id' | 'name'>;
export type Rec = Record<'foo' | 'bar', number>;
// Tuple entry, but the name is a non-identifier route path; the nested Pick's
// 'id' must also stay out (only DIRECT literal args of a tuple's generic count).
export type Routes = [Service<'/api/users', Pick<User, 'id'>, {}>];
// Bare string-literal tuple — not generic type arguments.
export type Names = ['alpha', 'beta'];
`;
      const result = extractFromSource('noise.ts', code);

      const leaked = result.nodes.filter(
        (n) =>
          (n.kind === 'method' || n.kind === 'property') &&
          ['id', 'name', 'foo', 'bar', 'alpha', 'beta'].includes(n.name)
      );
      expect(leaked).toEqual([]);
    });
  });
}
