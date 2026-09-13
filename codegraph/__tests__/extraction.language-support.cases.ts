import { getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerLanguageSupportTests(): void {


  describe('Language Support', () => {
    it('should report supported languages', () => {
      expect(isLanguageSupported('typescript')).toBe(true);
      expect(isLanguageSupported('python')).toBe(true);
      expect(isLanguageSupported('go')).toBe(true);
      expect(isLanguageSupported('unknown')).toBe(false);
    });

    it('should list all supported languages', () => {
      const languages = getSupportedLanguages();
      expect(languages).toContain('typescript');
      expect(languages).toContain('javascript');
      expect(languages).toContain('python');
      expect(languages).toContain('go');
      expect(languages).toContain('rust');
      expect(languages).toContain('java');
      expect(languages).toContain('csharp');
      expect(languages).toContain('php');
      expect(languages).toContain('ruby');
      expect(languages).toContain('swift');
      expect(languages).toContain('kotlin');
      expect(languages).toContain('dart');
      expect(languages).toContain('solidity');
      expect(languages).toContain('nix');
    });
  });
}
