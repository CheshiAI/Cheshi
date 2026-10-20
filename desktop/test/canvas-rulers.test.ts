import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { transformOpenPencilRulers } from '../frontend/open-pencil/rulers';

const coreRoot = path.dirname(createRequire(import.meta.url).resolve('@open-pencil/core/package.json'));
const modules = ['constants.js', 'canvas/rulers.js', 'canvas/renderer/overlay-pass.js', 'profiler/hud-renderer.js'];

describe('OpenPencil ruler size integration', () => {
  test('adapts every published SDK module that inlines ruler dimensions', () => {
    for (const module of modules) {
      const filename = path.join(coreRoot, 'dist', module);
      const source = readFileSync(filename, 'utf8');
      const transformed = transformOpenPencilRulers(source, filename);
      expect(transformed).not.toBeNull();
      expect(transformed).not.toBe(source);
      expect(readFileSync(filename, 'utf8')).toBe(source);
    }
  });

  test('ignores unrelated files and accepts Vite query suffixes', () => {
    const filename = path.join(coreRoot, 'dist/constants.js');
    const source = readFileSync(filename, 'utf8');
    expect(transformOpenPencilRulers(source, '/project/src/constants.js')).toBeNull();
    expect(transformOpenPencilRulers(source, filename + '?v=1')).toBe(transformOpenPencilRulers(source, filename));
  });

  test('requires review when the SDK layout changes instead of silently mixing sizes', () => {
    for (const module of modules) {
      expect(() => transformOpenPencilRulers('export const changed = true;', path.join(coreRoot, 'dist', module)))
        .toThrow('OpenPencil ruler integration needs review');
    }
  });
});
