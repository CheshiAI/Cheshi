import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerRustExtractionTests(): void {


  describe('Rust Extraction', () => {
    it('should extract function declarations', () => {
      const code = `
pub fn process_data(input: &str) -> Result<Output, Error> {
    // Process data
    Ok(Output::new())
}
`;
      const result = extractFromSource('lib.rs', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toBeDefined();
      expect(funcNode?.name).toBe('process_data');
      expect(funcNode?.visibility).toBe('public');
    });

    it('should extract struct declarations', () => {
      const code = `
pub struct User {
    pub id: String,
    pub name: String,
    email: String,
}
`;
      const result = extractFromSource('models.rs', code);

      const structNode = result.nodes.find((n) => n.kind === 'struct');
      expect(structNode).toBeDefined();
      expect(structNode?.name).toBe('User');
    });

    it('should extract trait declarations', () => {
      const code = `
pub trait Repository {
    fn find(&self, id: &str) -> Option<Entity>;
    fn save(&mut self, entity: Entity) -> Result<(), Error>;
}
`;
      const result = extractFromSource('traits.rs', code);

      const traitNode = result.nodes.find((n) => n.kind === 'trait');
      expect(traitNode).toBeDefined();
      expect(traitNode?.name).toBe('Repository');
    });

    it('should extract impl Trait for Type as implements edges', () => {
      const code = `
pub struct MyCache {}

pub trait Cache {
    fn get(&self, key: &str) -> Option<String>;
}

impl Cache for MyCache {
    fn get(&self, key: &str) -> Option<String> {
        None
    }
}
`;
      const result = extractFromSource('cache.rs', code);

      // Should have an unresolved reference for implements
      const implRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'implements' && r.referenceName === 'Cache'
      );
      expect(implRef).toBeDefined();

      // The struct MyCache should be the source
      const myCacheNode = result.nodes.find((n) => n.name === 'MyCache' && n.kind === 'struct');
      expect(myCacheNode).toBeDefined();
      expect(implRef?.fromNodeId).toBe(myCacheNode?.id);
    });

    it('should extract trait supertraits as extends references', () => {
      const code = `
pub trait Display {}

pub trait Error: Display {
    fn description(&self) -> &str;
}
`;
      const result = extractFromSource('error.rs', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends' && r.referenceName === 'Display'
      );
      expect(extendsRef).toBeDefined();

      const errorTrait = result.nodes.find((n) => n.name === 'Error' && n.kind === 'trait');
      expect(errorTrait).toBeDefined();
      expect(extendsRef?.fromNodeId).toBe(errorTrait?.id);
    });

    it('should not create implements edges for plain impl blocks', () => {
      const code = `
pub struct Counter {
    count: u32,
}

impl Counter {
    pub fn new() -> Counter {
        Counter { count: 0 }
    }
    pub fn increment(&mut self) {
        self.count += 1;
    }
}
`;
      const result = extractFromSource('counter.rs', code);

      // Should have no implements references (no trait involved)
      const implRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'implements'
      );
      expect(implRefs).toHaveLength(0);
    });
  });
}
