import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerDartMixinsAndTypeReferencesTests(): void {


  describe('Dart mixins and type references', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links `with` mixins and method parameter/return types across files', async () => {
      const lib = path.join(tempDir, 'lib');
      fs.mkdirSync(lib, { recursive: true });

      fs.writeFileSync(
        path.join(lib, 'models.dart'),
        `class User {
  final String name;
  User(this.name);
}

mixin Loggable {
  void log() {}
}

abstract class Repository {
  User find(int id);
}
`
      );
      fs.writeFileSync(
        path.join(lib, 'service.dart'),
        `import 'models.dart';

class UserService extends Repository with Loggable {
  @override
  User find(int id) => User('x');

  List<User> all() => [];
}
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const inModels = (name: string) =>
        cg.getNodesByKind('class').concat(cg.getNodesByKind('module'))
          .find((n) => n.name === name && n.filePath.endsWith('models.dart'));

      // The `with Loggable` mixin records a dependency — editing the mixin surfaces
      // the class that mixes it in (across files). Loggable is a `mixin`, indexed
      // as a class-like node.
      const loggable = cg.getNodesByKind('class').find((n) => n.name === 'Loggable')
        ?? cg.getNodesByKind('module').find((n) => n.name === 'Loggable');
      expect(loggable, 'Loggable mixin indexed').toBeDefined();
      const mixinUsers = [...cg.getImpactRadius(loggable!.id, 3).nodes.values()].map((n) => n.name);
      expect(mixinUsers).toContain('UserService');

      // `User` is used only as a method parameter/return type in service.dart —
      // editing it must still surface service.dart via the type references.
      const user = inModels('User') ?? cg.getNodesByKind('class').find((n) => n.name === 'User');
      expect(user, 'User indexed').toBeDefined();
      const userDeps = [...cg.getImpactRadius(user!.id, 3).nodes.values()].map((n) => n.filePath ?? '');
      expect(userDeps.some((p) => p.endsWith('service.dart'))).toBe(true);
    });
  });
}
