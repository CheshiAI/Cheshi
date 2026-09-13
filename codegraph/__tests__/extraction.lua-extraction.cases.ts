import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerLuaExtractionTests(): void {


  // =============================================================================
  // Lua
  // =============================================================================

  describe('Lua Extraction', () => {
    describe('Language detection', () => {
      it('should detect Lua files', () => {
        expect(detectLanguage('init.lua')).toBe('lua');
        expect(detectLanguage('src/util.lua')).toBe('lua');
      });

      it('should report Lua as supported', () => {
        expect(isLanguageSupported('lua')).toBe(true);
        expect(getSupportedLanguages()).toContain('lua');
      });
    });

    describe('Function extraction', () => {
      it('should extract global and local functions', () => {
        const code = /* language=TEXT */ `
function configure(opts) return opts end
local function helper(x) return x * 2 end
`;
        const result = extractFromSource('init.lua', code);
        const funcs = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
        expect(funcs).toContain('configure');
        expect(funcs).toContain('helper');
        const configure = result.nodes.find((n) => n.name === 'configure');
        expect(configure?.language).toBe('lua');
        expect(configure?.signature).toBe('(opts)');
      });

      it('should split table/method functions into a receiver and method name', () => {
        const code = /* language=TEXT */ `
function M.connect(host, port) return host end
function M:send(data) return self end
`;
        const result = extractFromSource('init.lua', code);
        const methods = result.nodes.filter((n) => n.kind === 'method');
        const connect = methods.find((m) => m.name === 'connect');
        expect(connect?.qualifiedName).toBe('M::connect');
        const send = methods.find((m) => m.name === 'send');
        expect(send?.qualifiedName).toBe('M::send');
      });
    });

    describe('Variable extraction', () => {
      it('should extract local variable declarations', () => {
        const code = /* language=TEXT */ `
local M = {}
local count = 0
`;
        const result = extractFromSource('mod.lua', code);
        const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
        expect(vars).toContain('M');
        expect(vars).toContain('count');
      });
    });

    describe('Import extraction (require)', () => {
      it('should extract require() in local declarations and bare calls', () => {
        const code = /* language=TEXT */ `
local socket = require("socket")
local http = require "resty.http"
require("side.effect")
`;
        const result = extractFromSource('net.lua', code);
        const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
        expect(imports).toContain('socket');
        expect(imports).toContain('resty.http');
        expect(imports).toContain('side.effect');

        const ref = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'imports' && r.referenceName === 'socket'
        );
        expect(ref).toBeDefined();
      });

      // Regression: the tree-sitter-wasms Lua grammar (ABI 13) corrupts the shared
      // WASM heap under web-tree-sitter 0.25, dropping nested calls/imports on every
      // parse after the first. We vendor the ABI-15 grammar instead — this guards it
      // by extracting several sources in sequence and asserting the LAST still works.
      it('should keep extracting require across many sequential parses', () => {
        let last;
        for (let i = 0; i < 8; i++) {
          last = extractFromSource(`f${i}.lua`, `local m = require("module.${i}")\nreturn m\n`);
        }
        const imports = last!.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
        expect(imports).toContain('module.7');
      });
    });

    describe('Call extraction', () => {
      it('should record intra-file calls as resolvable references', () => {
        const code = /* language=TEXT */ `
local function helper(x) return x end
local function run(y) return helper(y) end
`;
        const result = extractFromSource('calls.lua', code);
        const call = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'helper'
        );
        expect(call).toBeDefined();
      });
    });
  });
}
