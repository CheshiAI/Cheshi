import { describe, expect, test } from 'bun:test';

import { parseUnifiedDiff } from '../frontend/src/features/git/unifiedDiff';

describe('Git unified diff parser', () => {
  test('splits commit patches into files and tracks line numbers', () => {
    const files = parseUnifiedDiff(`diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -1,2 +1,3 @@
 const one = 1;
+const two = 2;
 export { one };
diff --git a/src/two.ts b/src/two.ts
deleted file mode 100644
--- a/src/two.ts
+++ /dev/null
@@ -4 +0,0 @@
-oldValue();
`);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'src/one.ts', additions: 1, deletions: 0 });
    expect(files[0]?.lines.find((line) => line.kind === 'addition')).toMatchObject({
      content: 'const two = 2;',
      oldLine: null,
      newLine: 2,
    });
    expect(files[1]).toMatchObject({ path: 'src/two.ts', oldPath: 'src/two.ts', additions: 0, deletions: 1 });
  });

  test('returns no files for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  test('ignores patch mail headers before the first file diff', () => {
    const files = parseUnifiedDiff(`From e3cf513947cacd40c981295dad5498697f081e90 Mon Sep 17 00:00:00 2001
From: DeeJay <deejay@example.test>
Date: Mon, 24 Aug 2026 23:27:02 +0900
Subject: [PATCH 1/1] update source

---
 src/example.ts | 1 +
 1 file changed, 1 insertion(+)

diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
 first
+second
`);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/example.ts',
      additions: 1,
      deletions: 0,
    });
    expect(files.some((file) => file.path === 'Diff')).toBe(false);
  });

  test('merges repeated file sections so rendered paths remain unique', () => {
    const files = parseUnifiedDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
 first
+second
diff --git a/src/example.ts b/src/example.ts
index 2222222..3333333 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,3 @@
 first
 second
+third
`);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/example.ts',
      additions: 2,
      deletions: 0,
    });
    expect(files[0]?.lines.filter((line) => line.content.startsWith('diff --git'))).toHaveLength(2);
  });

  test('parses quoted file paths containing spaces', () => {
    const files = parseUnifiedDiff(`diff --git "a/src/file name.ts" "b/src/file name.ts"
--- "a/src/file name.ts"
+++ "b/src/file name.ts"
@@ -1 +1 @@
-const oldValue = true;
+const newValue = true;
`);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/file name.ts',
      oldPath: 'src/file name.ts',
      additions: 1,
      deletions: 1,
    });
  });
});
