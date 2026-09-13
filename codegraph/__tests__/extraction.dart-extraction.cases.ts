import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerDartExtractionTests(): void {


  describe('Dart Extraction', () => {
    it('should extract class declarations', () => {
      const code = `
class UserService {
  final Database _db;

  Future<User> findById(String id) async {
    return await _db.query(id);
  }

  void _privateMethod() {}
}
`;
      const result = extractFromSource('service.dart', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('UserService');
      expect(classNode?.visibility).toBe('public');

      const methodNodes = result.nodes.filter((n) => n.kind === 'method');
      expect(methodNodes.length).toBeGreaterThanOrEqual(2);

      const findById = methodNodes.find((m) => m.name === 'findById');
      expect(findById).toBeDefined();
      expect(findById?.isAsync).toBe(true);

      const privateMethod = methodNodes.find((m) => m.name === '_privateMethod');
      expect(privateMethod).toBeDefined();
      expect(privateMethod?.visibility).toBe('private');

      // Dart models a method body as a SIBLING of the signature, so the method
      // node must be extended to span its body (not just the signature line) —
      // required for body-level analysis (callees, the callback synthesizer).
      expect(findById!.endLine).toBeGreaterThan(findById!.startLine);
    });

    it('should extract top-level function declarations', () => {
      const code = `
void topLevelFunction(String name) {
  print(name);
}
`;
      const result = extractFromSource('utils.dart', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toBeDefined();
      expect(funcNode?.name).toBe('topLevelFunction');
      expect(funcNode?.language).toBe('dart');
    });

    it('should extract enum declarations', () => {
      const code = `
enum Status { active, inactive, pending }
`;
      const result = extractFromSource('models.dart', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode).toBeDefined();
      expect(enumNode?.name).toBe('Status');
    });

    it('should extract mixin declarations', () => {
      const code = `
mixin LoggerMixin {
  void log(String message) {}
}
`;
      const result = extractFromSource('mixins.dart', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('LoggerMixin');

      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(methodNode).toBeDefined();
      expect(methodNode?.name).toBe('log');
    });

    it('should extract extension declarations', () => {
      const code = `
extension StringExt on String {
  bool get isBlank => trim().isEmpty;
}
`;
      const result = extractFromSource('extensions.dart', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('StringExt');
    });

    it('should detect static methods', () => {
      const code = `
class Utils {
  static void doWork() {}
}
`;
      const result = extractFromSource('utils.dart', code);

      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(methodNode).toBeDefined();
      expect(methodNode?.name).toBe('doWork');
      expect(methodNode?.isStatic).toBe(true);
    });

    it('should detect async functions', () => {
      const code = `
Future<String> fetchData() async {
  return await http.get('/data');
}
`;
      const result = extractFromSource('api.dart', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toBeDefined();
      expect(funcNode?.name).toBe('fetchData');
      expect(funcNode?.isAsync).toBe(true);
    });

    it('should detect private visibility via underscore convention', () => {
      const code = `
void _privateHelper() {}

void publicFunction() {}
`;
      const result = extractFromSource('helpers.dart', code);

      const functions = result.nodes.filter((n) => n.kind === 'function');
      const privateFunc = functions.find((f) => f.name === '_privateHelper');
      const publicFunc = functions.find((f) => f.name === 'publicFunction');

      expect(privateFunc?.visibility).toBe('private');
      expect(publicFunc?.visibility).toBe('public');
    });
  });
}
