import { aspnetResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerAspnetresolverExtractTests(): void {


  describe('aspnetResolver.extract', () => {
    it('extracts route from [HttpGet] attribute', () => {
      const src = `
[HttpGet("/users")]
public IActionResult ListUsers()
{
  return Ok();
}
`;
      const { nodes, references } = aspnetResolver.extract!('UserController.cs', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('ListUsers');
    });
  });
}
