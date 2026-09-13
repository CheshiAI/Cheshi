import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerCExtractionTests(): void {


  describe('C# Extraction', () => {
    it('should extract class declarations', () => {
      const code = `
public class OrderService
{
    private readonly IOrderRepository _repository;

    public OrderService(IOrderRepository repository)
    {
        _repository = repository;
    }

    public async Task<Order> GetOrderAsync(string id)
    {
        return await _repository.FindByIdAsync(id);
    }
}
`;
      const result = extractFromSource('OrderService.cs', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('OrderService');
      expect(classNode?.visibility).toBe('public');
    });

    it('indexes every record form with the right kind (#831)', () => {
      // The grammar parses ALL record forms as record_declaration — there is no
      // record_struct_declaration node — so the value-type forms are told apart
      // by their `struct` keyword child. Positional one-liners have no body
      // block and must still index (the no-body gate is for C/C++ forward
      // declarations, not records).
      const code = `
namespace Fixture;

public record SimplePositional(int A);
public record WithBody(int A) { public int DoubleIt() => A * 2; }
public record class ExplicitClassRec(string Name);
public record struct ValueRec(int X);
public readonly record struct ReadonlyRec(int X, int Y);
public record DerivedRec(int A, string B) : SimplePositional(A);
public record GenericRec<T>(T Value);
public partial record PartialRec(int A);
`;
      const result = extractFromSource('Records.cs', code);
      const kindOf = (name: string) => result.nodes.find((n) => n.name === name)?.kind;

      expect(kindOf('SimplePositional')).toBe('class');
      expect(kindOf('WithBody')).toBe('class');
      expect(kindOf('ExplicitClassRec')).toBe('class');
      expect(kindOf('DerivedRec')).toBe('class');
      expect(kindOf('GenericRec')).toBe('class');
      expect(kindOf('PartialRec')).toBe('class');
      // Value-type records are structs, not classes.
      expect(kindOf('ValueRec')).toBe('struct');
      expect(kindOf('ReadonlyRec')).toBe('struct');
      // Members of a bodied record still extract.
      expect(kindOf('DoubleIt')).toBe('method');
    });

    it('indexes primary-constructor classes, including keyed-DI attribute params (#237)', () => {
      // C# 12 primary constructors (`class Foo(IDep dep) { … }`) are parsed
      // natively by the vendored tree-sitter-c-sharp 0.23.x grammar. The worst
      // shape under the previous (older) grammar — an attribute-with-args on a
      // ctor param (`[FromKeyedServices("primary")] …`, the ASP.NET keyed-DI
      // pattern) — used to parse as an ERROR that swallowed the whole class, so
      // the class and all its methods vanished. They now index in every case.
      const code = `
public class DataService(IMemoryCache cache)
{
    public void Warm() { }
}

public class InstanceService(InstanceManager m, ProfileManager p)
{
    public void DeployAndLaunchAsync() { }
    public void Deploy() { }
}

public partial class UpdateService(int x) : ILifetimeService
{
    public void Run() { }
}

public class K1KeyedDi([FromKeyedServices("primary")] IMemoryCache cache)
{
    public void Warm() { }
}

public record CatalogBrand(int Id, string Name);
`;
      const result = extractFromSource('Services.cs', code);
      const classNames = result.nodes.filter((n) => n.kind === 'class').map((n) => n.name);
      expect(classNames).toContain('DataService');
      expect(classNames).toContain('InstanceService');
      expect(classNames).toContain('UpdateService'); // partial + base list
      expect(classNames).toContain('K1KeyedDi'); // attribute-arg ctor param — used to vanish entirely
      expect(classNames).toContain('CatalogBrand'); // record

      const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
      expect(methods).toContain('DeployAndLaunchAsync');
      expect(methods).toContain('Deploy');
      expect(methods).toContain('Run');
    });

    it('keeps a class indexable when a nested enum has #if-guarded members (#237)', () => {
      // A `#if` directive inside an enum member list (the multi-targeting pattern
      // in libraries like Newtonsoft.Json) makes the grammar emit an ERROR that,
      // for a nested enum, detaches the enclosing class's member list — dropping
      // most of the class's methods. A pre-parse pass blanks the directive lines
      // (keeping both branches), so the class and all its methods still index.
      const code = `
public class Reader
{
    private enum ReadType
    {
#if HAVE_DATE_TIME_OFFSET
        ReadAsDateTimeOffset,
#endif
        ReadAsDouble,
        ReadAsString,
    }

    public void Open() { }
    public void Close() { }
    public int ReadInt() { return 0; }
}
`;
      const result = extractFromSource('Reader.cs', code);
      const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
      // All three methods after the #if-bearing enum must survive.
      expect(methods).toContain('Open');
      expect(methods).toContain('Close');
      expect(methods).toContain('ReadInt');
      // Both enum branches are kept.
      const enumMembers = result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name);
      expect(enumMembers).toContain('ReadAsDateTimeOffset');
      expect(enumMembers).toContain('ReadAsDouble');
    });
  });
}
