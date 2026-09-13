import { playResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerPlayresolverExtractConfRoutesTests(): void {


  describe('playResolver.extract (conf/routes)', () => {
    it('extracts METHOD /path Controller.action routes, dropping the package + args', () => {
      const src = `# Routes
GET     /                    controllers.Application.index
GET     /computers           controllers.Application.list(p: Int ?= 0, s: Int ?= 2)
POST    /computers           controllers.Application.save
-> /v1/posts                 v1.post.PostRouter
`;
      const { nodes, references } = playResolver.extract!('conf/routes', src);
      expect(nodes.map((n) => n.name)).toEqual([
        'GET /',
        'GET /computers',
        'POST /computers',
      ]); // the `->` include is skipped
      expect(references.map((r) => r.referenceName)).toEqual([
        'Application.index',
        'Application.list',
        'Application.save',
      ]);
    });

    it('only runs on Play routes files', () => {
      expect(playResolver.extract!('app/Foo.scala', 'GET / controllers.X.y').nodes).toHaveLength(0);
    });
  });
}
