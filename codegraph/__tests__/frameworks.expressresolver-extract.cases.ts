import { expressResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerExpressresolverExtractTests(): void {


  describe('expressResolver.extract', () => {
    it('extracts route with inline handler reference', () => {
      const src = `app.get('/users', listUsers);\n`;
      const { nodes, references } = expressResolver.extract!('routes.ts', src);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('listUsers');
    });

    it('extracts route with router.post and middleware chain', () => {
      const src = `router.post('/items', auth, createItem);\n`;
      const { nodes, references } = expressResolver.extract!('items.ts', src);
      expect(nodes[0].name).toBe('POST /items');
      // Multiple handlers: prefer the LAST one (convention: middleware first, handler last)
      expect(references[0].referenceName).toBe('createItem');
    });

    it('extracts route with controller method reference', () => {
      const src = `app.get('/x', userController.list);\n`;
      const { references } = expressResolver.extract!('routes.ts', src);
      expect(references[0].referenceName).toBe('list');
    });
  });
}
