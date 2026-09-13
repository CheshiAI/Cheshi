import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerSwiftExtractionTests(): void {


  describe('Swift Extraction', () => {
    it('should extract class declarations', () => {
      const code = `
public class NetworkManager {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetchData(from url: URL) async throws -> Data {
        let (data, _) = try await session.data(from: url)
        return data
    }
}
`;
      const result = extractFromSource('NetworkManager.swift', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('NetworkManager');
    });

    it('should extract function declarations', () => {
      const code = `
func calculateSum(_ numbers: [Int]) -> Int {
    return numbers.reduce(0, +)
}

public func formatCurrency(amount: Double) -> String {
    return String(format: "$%.2f", amount)
}
`;
      const result = extractFromSource('utils.swift', code);

      const functions = result.nodes.filter((n) => n.kind === 'function');
      expect(functions.length).toBeGreaterThanOrEqual(1);
    });

    it('should extract struct declarations', () => {
      const code = `
public struct User {
    let id: UUID
    var name: String
    var email: String

    func displayName() -> String {
        return name
    }
}
`;
      const result = extractFromSource('User.swift', code);

      const structNode = result.nodes.find((n) => n.kind === 'struct');
      expect(structNode).toBeDefined();
      expect(structNode?.name).toBe('User');
    });

    it('should extract protocol declarations', () => {
      const code = `
public protocol Repository {
    associatedtype Entity

    func find(id: String) async throws -> Entity?
    func save(_ entity: Entity) async throws
}
`;
      const result = extractFromSource('Repository.swift', code);

      const protocolNode = result.nodes.find((n) => n.kind === 'interface');
      expect(protocolNode).toBeDefined();
      expect(protocolNode?.name).toBe('Repository');
    });

    it('should extract class inheritance and protocol conformance', () => {
      const code = `
class DataRequest: Request {
    func validate() {}
}

class UploadRequest: DataRequest, Sendable {
    func upload() {}
}

enum AFError: Error {
    case invalidURL
}

struct HTTPMethod: RawRepresentable {
    let rawValue: String
}

protocol UploadConvertible: URLRequestConvertible {
    func asURLRequest() throws -> URLRequest
}
`;
      const result = extractFromSource('Inheritance.swift', code);

      const extendsRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'extends'
      );

      // DataRequest extends Request
      expect(extendsRefs.find((r) => r.referenceName === 'Request')).toBeDefined();
      // UploadRequest extends DataRequest and Sendable
      expect(extendsRefs.find((r) => r.referenceName === 'DataRequest')).toBeDefined();
      expect(extendsRefs.find((r) => r.referenceName === 'Sendable')).toBeDefined();
      // AFError extends Error
      expect(extendsRefs.find((r) => r.referenceName === 'Error')).toBeDefined();
      // HTTPMethod extends RawRepresentable
      expect(extendsRefs.find((r) => r.referenceName === 'RawRepresentable')).toBeDefined();
      // UploadConvertible extends URLRequestConvertible
      expect(extendsRefs.find((r) => r.referenceName === 'URLRequestConvertible')).toBeDefined();
    });

    it('indexes Swift properties so they are findable: computed → property, stored → field, static → constant/variable (#1020)', () => {
      const code = `
struct ReproConfig {
    let reproStoredValue: Int
    var reproComputedFlag: Bool {
        reproStoredValue > 0
    }
    static let sharedLimit = 10
    static var sharedCount = 0
    func reproControlMethod() -> Bool {
        reproComputedFlag
    }
}

final class ReproService {
    private let reproClassStored: String = "x"
    var reproClassComputed: Int { reproClassStored.count }
}
`;
      const result = extractFromSource('Repro.swift', code);
      const byName = (name: string) => result.nodes.find((n) => n.name === name);

      // Computed properties are the regression this fix targets: before #1020 they
      // were dropped entirely, so search/explore returned nothing for them.
      expect(byName('reproComputedFlag')?.kind).toBe('property');
      expect(byName('reproClassComputed')?.kind).toBe('property');

      // Stored instance properties stay `field` (fixed earlier in #708 — guard it).
      expect(byName('reproStoredValue')?.kind).toBe('field');
      expect(byName('reproClassStored')?.kind).toBe('field');

      // `static let`/`static var` members remain shared constant/variable nodes.
      expect(byName('sharedLimit')?.kind).toBe('constant');
      expect(byName('sharedCount')?.kind).toBe('variable');

      // The control method is unaffected.
      expect(byName('reproControlMethod')?.kind).toBe('method');
    });

    it("attributes a computed property's getter calls to the property, not the type (SwiftUI body flow) (#1020)", () => {
      const code = `
struct GreetingView {
    let name: String
    var body: some View {
        let prefix = "Hi"
        return VStack {
            Text(greeting(prefix))
        }
    }
    func greeting(_ p: String) -> String { p }
}
`;
      const result = extractFromSource('View.swift', code);
      const body = result.nodes.find((n) => n.kind === 'property' && n.name === 'body');
      expect(body).toBeDefined();

      // The getter's call to greeting() must originate from `body` (so a SwiftUI
      // view's render flow is reachable through the property), not flatten onto the
      // enclosing struct.
      const callsFromBody = result.unresolvedReferences.filter(
        (r) => r.fromNodeId === body!.id && r.referenceKind === 'calls'
      );
      expect(callsFromBody.some((r) => r.referenceName === 'greeting')).toBe(true);

      // The getter is walked as a body, so a local declared inside it is NOT
      // node-ified (locals are the data-flow frontier we leave uncovered). Before
      // this fix the generic walker treated such a local as a struct `field`.
      expect(result.nodes.find((n) => n.name === 'prefix')).toBeUndefined();
    });

    it('indexes a Swift protocol property requirement as a findable property (#1020)', () => {
      const code = `
protocol Themable {
    var accentColor: Color { get }
    var title: String { get set }
}
`;
      const result = extractFromSource('Themable.swift', code);
      expect(result.nodes.find((n) => n.name === 'accentColor')?.kind).toBe('property');
      expect(result.nodes.find((n) => n.name === 'title')?.kind).toBe('property');
    });
  });
}
