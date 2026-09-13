import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerGoExtractionTests(): void {


  describe('Go Extraction', () => {
    it('should extract function declarations', () => {
      const code = `
package main

func ProcessOrder(order Order) (Receipt, error) {
    // Process the order
    return Receipt{}, nil
}
`;
      const result = extractFromSource('main.go', code);

      const funcNode = result.nodes.find((n) => n.kind === 'function');
      expect(funcNode).toBeDefined();
      expect(funcNode?.name).toBe('ProcessOrder');
    });

    it('should extract method declarations', () => {
      const code = `
package main

type Service struct {
    db *Database
}

func (s *Service) GetUser(id string) (*User, error) {
    return s.db.FindUser(id)
}
`;
      const result = extractFromSource('service.go', code);

      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(methodNode).toBeDefined();
      expect(methodNode?.name).toBe('GetUser');
    });
  });
}
