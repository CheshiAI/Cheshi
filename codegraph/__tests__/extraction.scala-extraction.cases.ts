import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerScalaExtractionTests(): void {


  // =============================================================================
  // Scala
  // =============================================================================

  describe('Scala Extraction', () => {
    describe('Language detection', () => {
      it('should detect Scala files', () => {
        expect(detectLanguage('Main.scala')).toBe('scala');
        expect(detectLanguage('script.sc')).toBe('scala');
        expect(detectLanguage('src/UserService.scala')).toBe('scala');
      });

      it('should report Scala as supported', () => {
        expect(isLanguageSupported('scala')).toBe(true);
        expect(getSupportedLanguages()).toContain('scala');
      });
    });

    describe('Class extraction', () => {
      it('should extract class definitions', () => {
        const code = `
class UserService(private val repo: UserRepository) {
  def findUser(id: String): Option[String] = Some(id)
}
`;
        const result = extractFromSource('UserService.scala', code);
        const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'UserService');
        expect(cls).toBeDefined();
        expect(cls?.language).toBe('scala');
      });

      it('should extract object definitions as class kind', () => {
        const code = `
object DatabaseConfig {
  val url = "jdbc:postgresql://localhost/mydb"
}
`;
        const result = extractFromSource('Config.scala', code);
        const obj = result.nodes.find((n) => n.kind === 'class' && n.name === 'DatabaseConfig');
        expect(obj).toBeDefined();
      });

      it('should extract trait definitions as trait kind', () => {
        const code = `
trait Repository[A] {
  def findById(id: String): Option[A]
  def save(entity: A): Unit
}
`;
        const result = extractFromSource('Repository.scala', code);
        const trait_ = result.nodes.find((n) => n.kind === 'trait' && n.name === 'Repository');
        expect(trait_).toBeDefined();
      });
    });

    describe('Method and function extraction', () => {
      it('should extract method definitions inside a class', () => {
        const code = `
class Calculator {
  def add(a: Int, b: Int): Int = a + b
  def divide(a: Double, b: Double): Double = a / b
}
`;
        const result = extractFromSource('Calculator.scala', code);
        const methods = result.nodes.filter((n) => n.kind === 'method');
        expect(methods.find((m) => m.name === 'add')).toBeDefined();
        expect(methods.find((m) => m.name === 'divide')).toBeDefined();
      });

      it('should extract method signatures', () => {
        const code = `
class Greeter {
  def greet(name: String): String = s"Hello, \${name}!"
}
`;
        const result = extractFromSource('Greeter.scala', code);
        const method = result.nodes.find((n) => n.name === 'greet');
        expect(method?.signature).toContain('name: String');
        expect(method?.signature).toContain('String');
      });

      it('should extract top-level function definitions as functions', () => {
        const code = `
def factorial(n: Int): Int = if (n <= 1) 1 else n * factorial(n - 1)
def greet(name: String): String = s"Hello, \${name}!"
`;
        const result = extractFromSource('utils.scala', code);
        const fns = result.nodes.filter((n) => n.kind === 'function');
        expect(fns.find((f) => f.name === 'factorial')).toBeDefined();
        expect(fns.find((f) => f.name === 'greet')).toBeDefined();
      });
    });

    describe('Val and var extraction', () => {
      it('should extract val inside a class as field', () => {
        const code = `
class Config {
  val timeout: Int = 30
  val host: String = "localhost"
}
`;
        const result = extractFromSource('Config.scala', code);
        const fields = result.nodes.filter((n) => n.kind === 'field');
        expect(fields.find((f) => f.name === 'timeout')).toBeDefined();
        expect(fields.find((f) => f.name === 'host')).toBeDefined();
      });

      it('should extract var inside a class as field', () => {
        const code = `
class Counter {
  var count: Int = 0
}
`;
        const result = extractFromSource('Counter.scala', code);
        const field = result.nodes.find((n) => n.kind === 'field' && n.name === 'count');
        expect(field).toBeDefined();
      });

      it('should extract top-level val as constant', () => {
        const code = `
val MaxConnections: Int = 100
val DefaultTimeout = 30
`;
        const result = extractFromSource('constants.scala', code);
        const consts = result.nodes.filter((n) => n.kind === 'constant');
        expect(consts.find((c) => c.name === 'MaxConnections')).toBeDefined();
      });

      it('should extract top-level var as variable', () => {
        const code = /* language=TEXT */ `
	var retries: Int = 3
`;
        const result = extractFromSource('state.scala', code);
        const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'retries');
        expect(v).toBeDefined();
      });

      it('should include type in val/var signature', () => {
        const code = /* language=TEXT */ `
class Service {
  val timeout: Int = 30
}
`;
        const result = extractFromSource('Service.scala', code);
        const field = result.nodes.find((n) => n.name === 'timeout');
        expect(field?.signature).toContain('timeout');
        expect(field?.signature).toContain('Int');
      });
    });

    describe('Enum extraction', () => {
      it('should extract enum definitions', () => {
        const code = /* language=TEXT */ `
enum Color:
  case Red
  case Green
  case Blue
`;
        const result = extractFromSource('Color.scala', code);
        const enumNode = result.nodes.find((n) => n.kind === 'enum' && n.name === 'Color');
        expect(enumNode).toBeDefined();
      });

      it('should extract enum cases as enum_member', () => {
        const code = /* language=TEXT */ `
enum Direction:
  case North
  case South
  case East
  case West
`;
        const result = extractFromSource('Direction.scala', code);
        const members = result.nodes.filter((n) => n.kind === 'enum_member');
        expect(members.find((m) => m.name === 'North')).toBeDefined();
        expect(members.find((m) => m.name === 'South')).toBeDefined();
        expect(members.length).toBeGreaterThanOrEqual(4);
      });
    });

    describe('Type alias extraction', () => {
      it('should extract type aliases', () => {
        const code = /* language=TEXT */ `
type UserId = String
type UserMap = Map[String, String]
`;
        const result = extractFromSource('types.scala', code);
        const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
        expect(aliases.find((a) => a.name === 'UserId')).toBeDefined();
        expect(aliases.find((a) => a.name === 'UserMap')).toBeDefined();
      });
    });

    describe('Import extraction', () => {
      it('should extract import declarations', () => {
        const code = /* language=TEXT */ `
import scala.collection.mutable.ListBuffer
import scala.concurrent.Future
`;
        const result = extractFromSource('imports.scala', code);
        const imports = result.nodes.filter((n) => n.kind === 'import');
        expect(imports.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe('Visibility modifiers', () => {
      it('should extract private visibility', () => {
        const code = /* language=TEXT */ `
class Service {
  private val secret: String = "abc"
  private def helper(): Unit = {}
}
`;
        const result = extractFromSource('Service.scala', code);
        const secretField = result.nodes.find((n) => n.name === 'secret');
        expect(secretField?.visibility).toBe('private');
        const helperMethod = result.nodes.find((n) => n.name === 'helper');
        expect(helperMethod?.visibility).toBe('private');
      });

      it('should extract protected visibility', () => {
        const code = /* language=TEXT */ `
class Base {
  protected def helperMethod(): Unit = {}
}
`;
        const result = extractFromSource('Base.scala', code);
        const method = result.nodes.find((n) => n.name === 'helperMethod');
        expect(method?.visibility).toBe('protected');
      });

      it('should default to public visibility', () => {
        const code = /* language=TEXT */ `
class Greeter {
  def hello(): Unit = {}
}
`;
        const result = extractFromSource('Greeter.scala', code);
        const method = result.nodes.find((n) => n.name === 'hello');
        expect(method?.visibility).toBe('public');
      });
    });

    describe('Inheritance', () => {
      it('should extract extends relationships', () => {
        const code = /* language=TEXT */ `
class AdminUser extends User {
  def adminAction(): Unit = {}
}
`;
        const result = extractFromSource('AdminUser.scala', code);
        const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
        expect(extendsRefs.find((r) => r.referenceName === 'User')).toBeDefined();
      });
    });

    describe('Call extraction', () => {
      it('should extract function call expressions', () => {
        const code = /* language=TEXT */ `
def processData(): Unit = {
  val result = computeResult()
  println(result)
}
`;
        const result = extractFromSource('processor.scala', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
        expect(calls.length).toBeGreaterThan(0);
      });
    });
  });
}
