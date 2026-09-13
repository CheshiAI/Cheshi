import { nestjsResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerNestjsresolverExtractHttpTests(): void {


  describe('nestjsResolver.extract — HTTP', () => {
    it('joins @Controller prefix with @Get and links the handler', () => {
      const src = `
@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }
}
`;
      const { nodes, references } = nestjsResolver.extract!('users.controller.ts', src);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].kind).toBe('route');
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('findAll');
      expect(references[0].referenceKind).toBe('references');
      expect(references[0].fromNodeId).toBe(nodes[0].id);
    });

    it('joins controller prefix with a method-level path param', () => {
      const src = `
@Controller('cats')
export class CatsController {
  @Get(':id')
  findOne(@Param('id') id: string) { return id; }
}
`;
      const { nodes, references } = nestjsResolver.extract!('cats.controller.ts', src);
      expect(nodes[0].name).toBe('GET /cats/:id');
      expect(references[0].referenceName).toBe('findOne');
    });

    it('handles an empty @Controller() and empty @Post()', () => {
      const src = `
@Controller()
export class AppController {
  @Post()
  create() {}
}
`;
      const { nodes, references } = nestjsResolver.extract!('app.controller.ts', src);
      expect(nodes[0].name).toBe('POST /');
      expect(references[0].referenceName).toBe('create');
    });

    it('covers HTTP verbs and skips intervening method decorators', () => {
      const src = `
@Controller('todos')
export class TodosController {
  @Put(':id')
  @UseGuards(AuthGuard)
  update(@Param('id') id: string) {}

  @Delete(':id')
  async remove(@Param('id') id: string) {}
}
`;
      const { nodes, references } = nestjsResolver.extract!('todos.controller.ts', src);
      expect(nodes.map((n) => n.name)).toEqual(['PUT /todos/:id', 'DELETE /todos/:id']);
      expect(references.map((r) => r.referenceName)).toEqual(['update', 'remove']);
    });

    it('attributes methods to the right controller when a file has two', () => {
      const src = `
@Controller('a')
export class AController {
  @Get('x')
  ax() {}
}

@Controller('b')
export class BController {
  @Get('y')
  by() {}
}
`;
      const { nodes } = nestjsResolver.extract!('multi.controller.ts', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /a/x', 'GET /b/y']);
    });
  });
}
