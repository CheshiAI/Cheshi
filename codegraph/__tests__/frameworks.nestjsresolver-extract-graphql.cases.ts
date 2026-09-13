import { nestjsResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerNestjsresolverExtractGraphqlTests(): void {


  describe('nestjsResolver.extract — GraphQL', () => {
    it('emits QUERY/MUTATION nodes from a resolver, defaulting to the method name', () => {
      const src = `
@Resolver(() => User)
export class UsersResolver {
  @Query(() => [User])
  users() { return []; }

  @Mutation(() => User)
  createUser(@Args('input') input: CreateUserInput) {}
}
`;
      const { nodes, references } = nestjsResolver.extract!('users.resolver.ts', src);
      expect(nodes.map((n) => n.name)).toEqual(['QUERY users', 'MUTATION createUser']);
      expect(references.map((r) => r.referenceName)).toEqual(['users', 'createUser']);
    });

    it('uses an explicit operation name when given', () => {
      const src = `
@Resolver()
export class CatsResolver {
  @Query(() => Cat, { name: 'cat' })
  getCat() {}
}
`;
      const { nodes } = nestjsResolver.extract!('cats.resolver.ts', src);
      expect(nodes[0].name).toBe('QUERY cat');
    });

    it('does NOT treat the REST @Query() parameter decorator as a GraphQL op', () => {
      const src = `
@Controller('search')
export class SearchController {
  @Get()
  search(@Query() query: SearchDto) { return query; }
}
`;
      const { nodes } = nestjsResolver.extract!('search.controller.ts', src);
      // Only the HTTP route — the @Query() param decorator must be ignored.
      expect(nodes.map((n) => n.name)).toEqual(['GET /search']);
    });
  });
}
