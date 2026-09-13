import { vaporResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerVaporresolverExtractTests(): void {


  describe('vaporResolver.extract', () => {
    it('extracts route from app.get with use:', () => {
      const src = `app.get("users", use: listUsers)\n`;
      const { nodes, references } = vaporResolver.extract!('routes.swift', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('listUsers');
    });

    it('extracts grouped RouteCollection routes with the group prefix and no path arg', () => {
      const src = `
func boot(routes: RoutesBuilder) throws {
    let todos = routes.grouped("todos")
    todos.get(use: index)
    todos.post(use: create)
    todos.group(":todoID") { todo in
        todo.delete(use: delete)
    }
}
`;
      const { nodes, references } = vaporResolver.extract!('TodoController.swift', src);
      expect(nodes.map((n) => n.name).sort()).toEqual([
        'DELETE /todos/:todoID',
        'GET /todos',
        'POST /todos',
      ]);
      expect(references.map((r) => r.referenceName).sort()).toEqual([
        'create',
        'delete',
        'index',
      ]);
    });

    it('handles use: self.handler and non-string path segments', () => {
      const src = `router.get("users", User.parameter, "edit", use: self.editUserHandler)\n`;
      const { nodes, references } = vaporResolver.extract!('UserController.swift', src);
      expect(nodes[0].name).toBe('GET /users/edit');
      expect(references[0].referenceName).toBe('editUserHandler');
    });

    it('ignores non-route .get calls that lack use: (e.g. Environment.get)', () => {
      const src = `let host = Environment.get("DATABASE_HOST") ?? "localhost"\n`;
      const { nodes } = vaporResolver.extract!('configure.swift', src);
      expect(nodes).toHaveLength(0);
    });
  });
}
