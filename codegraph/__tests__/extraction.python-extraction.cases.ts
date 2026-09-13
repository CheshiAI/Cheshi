import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerPythonExtractionTests(): void {


  describe('Python Extraction', () => {
    it('should extract function definitions', () => {
      const code = `
def calculate_total(items: list, tax_rate: float) -> float:
    """Calculate total with tax."""
    subtotal = sum(item.price for item in items)
    return subtotal * (1 + tax_rate)
`;
      const result = extractFromSource('calc.py', code);

      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toMatchObject({
        kind: 'function',
        name: 'calculate_total',
        language: 'python',
      });
    });

    it('should extract class definitions', () => {
      const code = `
class UserService:
    """Service for managing users."""

    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str) -> User:
        return self.db.find_user(user_id)
`;
      const result = extractFromSource('service.py', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('UserService');
    });
  });
}
