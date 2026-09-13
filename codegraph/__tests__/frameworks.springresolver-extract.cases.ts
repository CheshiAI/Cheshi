import { springResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerSpringresolverExtractTests(): void {


  describe('springResolver.extract', () => {
    it('extracts route with @GetMapping and next method', () => {
      const src = `
@GetMapping("/users")
public List<User> listUsers() {
  return users;
}
`;
      const { nodes, references } = springResolver.extract!('UserController.java', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('listUsers');
    });

    it('extracts a Kotlin @GetMapping with a fun handler', () => {
      const src = `
@GetMapping("/vets")
fun showVetList(model: MutableMap<String, Any>): String {
  return "vets"
}
`;
      const { nodes, references } = springResolver.extract!('VetController.kt', src);
      expect(nodes[0].name).toBe('GET /vets');
      expect(references[0].referenceName).toBe('showVetList');
      expect(nodes[0].language).toBe('kotlin');
    });

    it('joins a Kotlin class @RequestMapping prefix and skips a stacked annotation', () => {
      const src = `
@RestController
@RequestMapping("/owners")
class OwnerController {
  @GetMapping("/{ownerId}")
  @ResponseBody
  fun showOwner(@PathVariable ownerId: Int): String {
    return "owner"
  }
}
`;
      const { nodes, references } = springResolver.extract!('OwnerController.kt', src);
      expect(nodes[0].name).toBe('GET /owners/{ownerId}');
      expect(references[0].referenceName).toBe('showOwner');
    });
  });
}
