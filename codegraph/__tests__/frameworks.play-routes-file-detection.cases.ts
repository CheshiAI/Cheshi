import { isPlayRoutesFile, isSourceFile } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerPlayRoutesFileDetectionTests(): void {


  describe('Play routes file detection', () => {
    it('recognizes conf/routes (extensionless) and *.routes as source files', () => {
      expect(isPlayRoutesFile('conf/routes')).toBe(true);
      expect(isPlayRoutesFile('myapp/conf/routes')).toBe(true);
      expect(isPlayRoutesFile('conf/admin.routes')).toBe(true);
      expect(isSourceFile('conf/routes')).toBe(true);
      expect(isPlayRoutesFile('src/routes.ts')).toBe(false);
    });
  });
}
