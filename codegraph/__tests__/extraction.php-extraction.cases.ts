import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerPhpExtractionTests(): void {


  describe('PHP Extraction', () => {
    it('should extract class declarations', () => {
      const code = `<?php

class UserController
{
    private UserService $userService;

    public function __construct(UserService $userService)
    {
        $this->userService = $userService;
    }

    public function show(string $id): User
    {
        return $this->userService->find($id);
    }
}
`;
      const result = extractFromSource('UserController.php', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('UserController');
    });

    it('should extract class inheritance (extends) and interface implementation', () => {
      const code = `<?php

class ChildController extends BaseController implements Serializable, JsonSerializable
{
    public function serialize(): string
    {
        return json_encode($this);
    }
}
`;
      const result = extractFromSource('ChildController.php', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('ChildController');

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      expect(extendsRef).toBeDefined();
      expect(extendsRef?.referenceName).toBe('BaseController');

      const implementsRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'implements'
      );
      expect(implementsRefs.length).toBe(2);
      expect(implementsRefs.map((r) => r.referenceName)).toContain('Serializable');
      expect(implementsRefs.map((r) => r.referenceName)).toContain('JsonSerializable');
    });
  });
}
