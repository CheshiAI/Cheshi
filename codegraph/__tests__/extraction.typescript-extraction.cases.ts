import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerTypescriptExtractionTests(): void {


  describe('TypeScript Extraction', () => {
    it('should extract function declarations', () => {
      const code = `
export function processPayment(amount: number): Promise<Receipt> {
  return stripe.charge(amount);
}
`;
      const result = extractFromSource('payment.ts', code);

      // File node + function node
      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();
      expect(fileNode?.name).toBe('payment.ts');

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toMatchObject({
        kind: 'function',
        name: 'processPayment',
        language: 'typescript',
        isExported: true,
      });
      expect(funcNode?.signature).toContain('amount: number');
    });

    it('should extract class declarations', () => {
      const code = `
export class PaymentService {
  private stripe: StripeClient;

  constructor(apiKey: string) {
    this.stripe = new StripeClient(apiKey);
  }

  async charge(amount: number): Promise<Receipt> {
    return this.stripe.charge(amount);
  }
}
`;
      const result = extractFromSource('service.ts', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      const methodNodes = result.nodes.filter((n) => n.kind === 'method');

      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('PaymentService');
      expect(classNode?.isExported).toBe(true);

      expect(methodNodes.length).toBeGreaterThanOrEqual(1);
      const chargeMethod = methodNodes.find((m) => m.name === 'charge');
      expect(chargeMethod).toBeDefined();
    });

    it('captures docstrings for export- and const-wrapped declarations (#780)', () => {
      const code = `
// plain class control
class Ledger {}

// exported class
export class Invoice {}

// export default
export default function settle() { return true; }

// exported arrow const
export const refund = (amount: number) => amount;

// non-export arrow const
const audit = (amount: number) => amount;
`;
      const byName = new Map(extractFromSource('doc.ts', code).nodes.map((n) => [n.name, n]));
      expect(byName.get('Ledger')?.docstring).toBe('plain class control'); // control still works
      expect(byName.get('Invoice')?.docstring).toBe('exported class');
      expect(byName.get('settle')?.docstring).toBe('export default');
      expect(byName.get('refund')?.docstring).toBe('exported arrow const');
      expect(byName.get('audit')?.docstring).toBe('non-export arrow const');
    });

    it('does not mis-attribute a class comment to an uncommented member (#780)', () => {
      const code = `
// Comment for Box
export class Box {
  noComment() {}
  // own comment
  withComment() {}
}
`;
      const byName = new Map(extractFromSource('box.ts', code).nodes.map((n) => [n.name, n]));
      expect(byName.get('Box')?.docstring).toBe('Comment for Box');
      expect(byName.get('noComment')?.docstring ?? null).toBeNull(); // no over-walk
      expect(byName.get('withComment')?.docstring).toBe('own comment');
    });

    it('captures docstrings for decorated Python declarations, stripping `#` (#780)', () => {
      const code = [
        '# decorated function',
        '@app.route("/x")',
        'def py_handler():',
        '    return 1',
        '',
        '',
        '# plain function control',
        'def py_plain():',
        '    return 1',
        '',
        '',
        '# decorated class',
        '@dataclass',
        'class PyModel:',
        '    pass',
        '',
      ].join('\n');
      const byName = new Map(extractFromSource('mod.py', code).nodes.map((n) => [n.name, n]));
      expect(byName.get('py_handler')?.docstring).toBe('decorated function');
      expect(byName.get('py_plain')?.docstring).toBe('plain function control'); // `#` stripped
      expect(byName.get('PyModel')?.docstring).toBe('decorated class');
    });

    it('cleans comment markers across language styles (#780)', () => {
      const doc = (file: string, code: string, name: string) =>
        new Map(extractFromSource(file, code).nodes.map((n) => [n.name, n])).get(name)?.docstring;

      // Rust doc lines (`///`, `//!`) — the trailing slash used to leak through.
      expect(doc('m.rs', '/// rust doc line\nfn rs_fn() {}', 'rs_fn')).toBe('rust doc line');
      // Lua line + long-bracket comments.
      expect(doc('m.lua', '-- lua line\nfunction lua_fn() end', 'lua_fn')).toBe('lua line');
      expect(doc('b.lua', '--[[ lua block ]]\nfunction lua_b() end', 'lua_b')).toBe('lua block');
      // Pascal brace and paren-star comments.
      const pasUnit = (c: string) =>
        `unit U;\ninterface\n${c}\nprocedure P;\nimplementation\nprocedure P;\nbegin\nend;\nend.\n`;
      expect(doc('a.pas', pasUnit('{ pascal brace }'), 'P')).toBe('pascal brace');
      expect(doc('c.pas', pasUnit('(* pascal paren *)'), 'P')).toBe('pascal paren');
      // C block comment still clean (no regression).
      expect(doc('m.c', '/* c block */\nvoid c_fn(void) {}', 'c_fn')).toBe('c block');
    });

    it('should extract interfaces', () => {
      const code = `
export interface User {
  id: string;
  name: string;
  email: string;
}
`;
      const result = extractFromSource('types.ts', code);

      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toMatchObject({
        kind: 'interface',
        name: 'User',
        isExported: true,
      });
    });

    it('should extract type references from interface property signatures', () => {
      const code = `
import type { IPage } from '../PromoterList';
import type { IOrderField } from '../types';

interface Hprops {
  value?: Partial<IPage> & Partial<IOrderField>;
}
`;
      const result = extractFromSource('HeaderFilter.ts', code);

      const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
      expect(refs.some((r) => r.referenceName === 'IPage')).toBe(true);
      expect(refs.some((r) => r.referenceName === 'IOrderField')).toBe(true);
    });

    it('should extract type references from interface method signatures', () => {
      const code = `
import type { IPage } from '../PromoterList';
import type { IOrderField } from '../types';

interface MethodForm {
  fetchPage(arg: IPage): IOrderField;
}
`;
      const result = extractFromSource('MethodForm.ts', code);

      const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
      expect(refs.some((r) => r.referenceName === 'IPage')).toBe(true);
      expect(refs.some((r) => r.referenceName === 'IOrderField')).toBe(true);
    });

    it('extracts type references from in-body local variable annotations', () => {
      // A function that uses a type ONLY in its body — `const items: Foo[] = []` —
      // still depends on Foo. The body walker used to capture calls but never type
      // annotations, so impact / `affected` missed the dependency. Must cover
      // function, class-method, and object-literal-method bodies — and must NOT
      // turn the locals themselves into graph nodes (that would explode the graph).
      const code = `
import { Foo } from './types';

export function build(): void {
  const items: Foo[] = [];
  void items;
}

export class K {
  run(): void {
    const a: Foo = { x: 1 };
    void a;
  }
}

export const handler = {
  handle(): void {
    const b: Foo = { x: 1 };
    void b;
  },
};
`;
      const result = extractFromSource('inbody.ts', code);

      const fooRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'references' && r.referenceName === 'Foo'
      );
      // One per body scope: build(), K.run(), handler.handle().
      expect(fooRefs.length).toBeGreaterThanOrEqual(3);

      // Each reference is attributed to its enclosing function/method node — never
      // to a local-variable node, because locals are intentionally not extracted.
      const byId = new Map(result.nodes.map((n) => [n.id, n]));
      for (const ref of fooRefs) {
        const owner = byId.get(ref.fromNodeId);
        expect(owner).toBeDefined();
        expect(['function', 'method']).toContain(owner!.kind);
      }
      // The locals (items/a/b) must not leak in as symbols.
      expect(result.nodes.some((n) => ['items', 'a', 'b'].includes(n.name))).toBe(false);
    });

    it('should track function calls', () => {
      const code = `
function main() {
  const result = processData();
  console.log(result);
}
`;
      const result = extractFromSource('main.ts', code);

      expect(result.unresolvedReferences.length).toBeGreaterThan(0);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      expect(calls.some((c) => c.referenceName === 'processData')).toBe(true);
    });
  });
}
