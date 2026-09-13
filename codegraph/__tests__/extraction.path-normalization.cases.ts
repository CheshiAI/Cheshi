import { normalizePath } from '../src/utils';
import { describe, expect, it } from 'bun:test';

export function registerPathNormalizationTests(): void {


  describe('Path Normalization', () => {
    it('should convert backslashes to forward slashes', () => {
      expect(normalizePath('gui\\node_modules\\foo')).toBe('gui/node_modules/foo');
      expect(normalizePath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx');
    });

    it('should leave forward-slash paths unchanged', () => {
      expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
    });

    it('should handle empty string', () => {
      expect(normalizePath('')).toBe('');
    });
  });
}
