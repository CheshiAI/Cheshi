import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerScalaCrossFileDependenciesTests(): void {


  describe('Scala cross-file dependencies', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links parameterized supertypes, type annotations, and implicit params across files', async () => {
      const src = path.join(tempDir, 'src', 'main', 'scala', 'demo');
      fs.mkdirSync(src, { recursive: true });

      fs.writeFileSync(
        path.join(src, 'Semigroup.scala'),
        `package demo

trait Semigroup[A] {
  def combine(x: A, y: A): A
}
`
      );
      fs.writeFileSync(
        path.join(src, 'Monoid.scala'),
        `package demo

trait Monoid[A] extends Semigroup[A] {
  def empty: A
}
`
      );
      fs.writeFileSync(
        path.join(src, 'Instances.scala'),
        `package demo

object Instances {
  implicit val intMonoid: Monoid[Int] = new Monoid[Int] {
    def empty: Int = 0
    def combine(x: Int, y: Int): Int = x + y
  }
}
`
      );
      fs.writeFileSync(
        path.join(src, 'Folding.scala'),
        `package demo

object Folding {
  def fold[A](xs: List[A])(implicit M: Monoid[A]): A =
    xs.foldLeft(M.empty)(M.combine)
}
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const monoid = cg.getNodesByKind('trait').find((n) => n.name === 'Monoid');
      const semigroup = cg.getNodesByKind('trait').find((n) => n.name === 'Semigroup');
      expect(monoid).toBeDefined();
      expect(semigroup).toBeDefined();
      expect(monoid!.filePath).not.toBe(semigroup!.filePath);

      // Parameterized supertype `extends Semigroup[A]` must create an extends edge —
      // the whole point of the fix (the `[A]` used to defeat name matching).
      const semaImpact = cg.getImpactRadius(semigroup!.id, 3);
      expect([...semaImpact.nodes.values()].map((n) => n.name)).toContain('Monoid');

      // Editing Monoid surfaces the cross-file users: the instance val typed
      // `Monoid[Int]` and the method taking it as an implicit (curried) param.
      const impacted = [...cg.getImpactRadius(monoid!.id, 3).nodes.values()].map((n) => n.name);
      expect(impacted).toContain('intMonoid'); // field type annotation
      expect(impacted).toContain('fold'); // trailing implicit parameter list
    });
  });
}
