import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerLuauExtractionTests(): void {


  // =============================================================================
  // Luau (typed superset of Lua — https://luau.org)
  // =============================================================================

  describe('Luau Extraction', () => {
    describe('Language detection', () => {
      it('should detect Luau files', () => {
        expect(detectLanguage('init.luau')).toBe('luau');
        expect(detectLanguage('src/Client.luau')).toBe('luau');
      });

      it('should report Luau as supported', () => {
        expect(isLanguageSupported('luau')).toBe(true);
        expect(getSupportedLanguages()).toContain('luau');
      });
    });

    describe('Type aliases', () => {
      it('should extract `type` and `export type` definitions', () => {
        const code = /* language=TEXT */ `
export type Vector = { x: number, y: number }
type Handler = (msg: string) -> boolean
`;
        const result = extractFromSource('types.luau', code);
        const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
        const vector = aliases.find((a) => a.name === 'Vector');
        expect(vector).toBeDefined();
        expect(vector?.isExported).toBe(true);
        const handler = aliases.find((a) => a.name === 'Handler');
        expect(handler).toBeDefined();
        expect(handler?.isExported).toBe(false);
      });
    });

    describe('Typed functions and methods', () => {
      it('should capture typed signatures and split methods by receiver', () => {
        const code = /* language=TEXT */ `
function configure(opts: { debug: boolean }): boolean
	return opts.debug
end
function Client:fetch(path: string): Response
	return path
end
`;
        const result = extractFromSource('client.luau', code);
        const configure = result.nodes.find((n) => n.kind === 'function' && n.name === 'configure');
        expect(configure?.language).toBe('luau');
        expect(configure?.signature).toBe('(opts: { debug: boolean }): boolean');
        const fetch = result.nodes.find((n) => n.kind === 'method' && n.name === 'fetch');
        expect(fetch?.qualifiedName).toBe('Client::fetch');
      });
    });

    describe('Imports and variables', () => {
      it('should extract string and Roblox instance-path require imports', () => {
        const code = /* language=TEXT */ `
local http = require("http")
local Signal = require(script.Parent.Signal)
local count = 0
`;
        const result = extractFromSource('mod.luau', code);
        const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
        expect(imports).toContain('http'); // string require
        expect(imports).toContain('Signal'); // Roblox instance-path require
        const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
        expect(vars).toContain('count');
      });
    });
  });
}
