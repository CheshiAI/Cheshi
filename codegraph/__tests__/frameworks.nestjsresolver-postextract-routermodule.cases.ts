import type { Node } from '../src';
import { nestjsResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerNestjsresolverPostextractRoutermoduleTests(): void {


  describe('nestjsResolver.postExtract — RouterModule', () => {
    function mkClass(name: string, filePath: string, startLine: number, endLine: number): Node {
      return {
        id: `class:${filePath}:${startLine}:${name}`,
        kind: 'class',
        name,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        language: 'typescript',
        startLine,
        endLine,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 0,
      };
    }

    function mkRoute(
      filePath: string,
      line: number,
      method: string,
      path: string,
      nameOverride?: string
    ): Node {
      return {
        id: `route:${filePath}:${line}:${method}:${path}`,
        kind: 'route',
        name: nameOverride ?? `${method} ${path}`,
        qualifiedName: `${filePath}::${method}:${path}`,
        filePath,
        language: 'typescript',
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 0,
      };
    }

    function makeContext(opts: {
      files?: Record<string, string>;
      nodes?: Node[];
    }) {
      const files = opts.files ?? {};
      const all = opts.nodes ?? [];
      return {
        getNodesInFile: (fp: string) => all.filter((n) => n.filePath === fp),
        getNodesByName: (name: string) => all.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: (kind: Node['kind']) => all.filter((n) => n.kind === kind),
        fileExists: (fp: string) => files[fp] !== undefined,
        readFile: (fp: string) => files[fp] ?? null,
        getProjectRoot: () => '/test',
        getAllFiles: () => Object.keys(files),
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      } as any;
    }

    it('prepends RouterModule prefix to a controller route (top-level register)', () => {
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          @Module({
            imports: [
              RouterModule.register([
                { path: 'admin', module: AdminModule },
              ]),
            ],
          })
          export class AppModule {}

          @Module({ controllers: [AdminController] })
          export class AdminModule {}
        `,
        },
        nodes: [
          mkClass('AdminController', 'src/admin/admin.controller.ts', 1, 10),
          mkRoute('src/admin/admin.controller.ts', 3, 'GET', '/'),
        ],
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.name).toBe('GET /admin');
      // id and qualifiedName must be preserved so existing route→handler edges
      // stay intact and the pass remains idempotent on a second run.
      expect(updates[0]!.id).toBe('route:src/admin/admin.controller.ts:3:GET:/');
      expect(updates[0]!.qualifiedName).toBe('src/admin/admin.controller.ts::GET:/');
    });

    it('resolves nested children — the issue #459 example', () => {
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          @Module({
            imports: [
              AdminModule,
              UsersModule,
              RouterModule.register([
                {
                  path: 'admin',
                  module: AdminModule,
                  children: [
                    { path: 'users', module: UsersModule },
                  ],
                },
              ]),
            ],
          })
          export class AppModule {}
        `,
          'src/users/users.module.ts': `
          @Module({ controllers: [UsersController] })
          export class UsersModule {}
        `,
        },
        nodes: [
          mkClass('UsersController', 'src/users/users.controller.ts', 1, 10),
          mkRoute('src/users/users.controller.ts', 3, 'GET', '/'),
        ],
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.name).toBe('GET /admin/users');
    });

    it('joins module prefix with a non-empty @Controller path and method params', () => {
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          RouterModule.register([{ path: 'admin', module: UsersModule }])

          @Module({ controllers: [UsersController] })
          export class UsersModule {}
        `,
        },
        nodes: [
          mkClass('UsersController', 'src/users.controller.ts', 1, 10),
          // Existing extract emitted GET /users/:id from @Controller('users') + @Get(':id')
          mkRoute('src/users.controller.ts', 3, 'GET', '/users/:id'),
        ],
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.name).toBe('GET /admin/users/:id');
    });

    it('is idempotent — a second run returns no updates', () => {
      // Simulate the state after one round of postExtract: name is already
      // 'GET /admin', but qualifiedName still encodes the original 'GET:/'.
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          RouterModule.register([{ path: 'admin', module: UsersModule }])
          @Module({ controllers: [UsersController] })
          export class UsersModule {}
        `,
        },
        nodes: [
          mkClass('UsersController', 'src/users.controller.ts', 1, 10),
          mkRoute('src/users.controller.ts', 3, 'GET', '/', 'GET /admin'),
        ],
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(0);
    });

    it('is a no-op when the project does not use RouterModule', () => {
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          @Module({ controllers: [UsersController] })
          export class AppModule {}
        `,
        },
        nodes: [
          mkClass('UsersController', 'src/users.controller.ts', 1, 10),
          mkRoute('src/users.controller.ts', 3, 'GET', '/'),
        ],
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(0);
    });

    it('attributes routes to the right controller when one file has two', () => {
      // Two controllers in one file, declared in two different modules with
      // two different module prefixes. The route's startLine has to match the
      // class scope, not just the file path.
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          RouterModule.register([
            { path: 'p1', module: AModule },
            { path: 'p2', module: BModule },
          ])
          @Module({ controllers: [AController] }) export class AModule {}
          @Module({ controllers: [BController] }) export class BModule {}
        `,
        },
        nodes: [
          mkClass('AController', 'src/multi.controller.ts', 1, 5),
          mkClass('BController', 'src/multi.controller.ts', 7, 12),
          mkRoute('src/multi.controller.ts', 3, 'GET', '/a/x'),
          mkRoute('src/multi.controller.ts', 9, 'GET', '/b/y'),
        ],
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(2);
      const byId = new Map(updates.map((u) => [u.id, u.name]));
      expect(byId.get('route:src/multi.controller.ts:3:GET:/a/x')).toBe('GET /p1/a/x');
      expect(byId.get('route:src/multi.controller.ts:9:GET:/b/y')).toBe('GET /p2/b/y');
    });

    it('merges RouterModule registrations spread across multiple module files', () => {
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          RouterModule.register([{ path: 'a', module: AModule }])
          @Module({ controllers: [AController] }) export class AModule {}
        `,
          'src/feature.module.ts': `
          RouterModule.forChild([{ path: 'b', module: BModule }])
          @Module({ controllers: [BController] }) export class BModule {}
        `,
        },
        nodes: [
          mkClass('AController', 'src/a.controller.ts', 1, 5),
          mkClass('BController', 'src/b.controller.ts', 1, 5),
          mkRoute('src/a.controller.ts', 3, 'GET', '/'),
          mkRoute('src/b.controller.ts', 3, 'GET', '/'),
        ],
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(2);
      const byId = new Map(updates.map((u) => [u.id, u.name]));
      expect(byId.get('route:src/a.controller.ts:3:GET:/')).toBe('GET /a');
      expect(byId.get('route:src/b.controller.ts:3:GET:/')).toBe('GET /b');
    });

    it('silently skips controllers whose class node is not in the graph', () => {
      // RouterModule declares a prefix for a module, but the @Module that
      // would link it to a controller is missing — common during partial
      // re-extraction. Must not throw.
      const ctx = makeContext({
        files: {
          'src/app.module.ts': `
          RouterModule.register([{ path: 'orphans', module: GhostModule }])
          @Module({ controllers: [GhostController] }) export class GhostModule {}
        `,
        },
        nodes: [], // no class or route nodes
      });

      const updates = nestjsResolver.postExtract!(ctx);
      expect(updates).toHaveLength(0);
    });
  });
}
