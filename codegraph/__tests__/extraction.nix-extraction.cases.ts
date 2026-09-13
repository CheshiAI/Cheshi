import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerNixExtractionTests(): void {


  describe('Nix Extraction', () => {
    it('should distinguish Nix variable and function bindings', () => {
      const code = `
let
  plainValue = 10;
  simpleFn = arg: arg + 1;
  destructuredFn = { lib, stdenv }: lib.getName stdenv;
  curriedFn = a: b: builtins.toString (a + b);
in
{
  exportedValue = plainValue;
  exportedFn = curriedFn;
}
`;

      const result = extractFromSource('default.nix', code);

      expect(result.nodes.find((n) => n.kind === 'variable' && n.name === 'plainValue')).toBeDefined();
      expect(result.nodes.find((n) => n.kind === 'variable' && n.name === 'exportedValue')).toBeDefined();

      const simpleFn = result.nodes.find((n) => n.kind === 'function' && n.name === 'simpleFn');
      const destructuredFn = result.nodes.find((n) => n.kind === 'function' && n.name === 'destructuredFn');
      const curriedFn = result.nodes.find((n) => n.kind === 'function' && n.name === 'curriedFn');

      expect(simpleFn?.signature).toBe('(arg)');
      expect(destructuredFn?.signature).toBe('{ lib, stdenv }');
      expect(curriedFn?.signature).toBe('a : b');

      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
      expect(calls).toContain('lib.getName');
      expect(calls.filter((name) => name === 'builtins.toString')).toHaveLength(1);
    });

    it('should extract inherited Nix attributes as variables', () => {
      const code = `
let
  inherit lib;
  inherit (pkgs) stdenv writeShellScriptBin;
in
stdenv.mkDerivation {}
`;

      const result = extractFromSource('default.nix', code);
      const variables = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);

      expect(variables).toContain('lib');
      expect(variables).toContain('stdenv');
      expect(variables).toContain('writeShellScriptBin');
    });

    it('should emit only static project path imports for Nix import calls', () => {
      const code = `
let
  local = import ./x.nix;
  defaultFile = builtins.import ./dir;
  packageSet = import <nixpkgs> {};
  fromSources = import sources.nixpkgs {};
  dynamic = import selectedPath;
in
local
`;

      const result = extractFromSource('default.nix', code);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      const importRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName);

      expect(imports).toEqual(['./x.nix', './dir']);
      expect(importRefs).toEqual(['./x.nix', './dir']);
    });

    it('should emit file imports for NixOS module imports/modules lists (literal paths only)', () => {
      const code = `
{ config, lib, ... }:
{
  imports = [ ./hardware.nix ../common inputs.foo.nixosModules.bar ];
  home-manager.users.demo.imports = [ ./home.nix ];
  flake.modules = [ ./configuration.nix ];
  notAModuleList = [ ./ignored.nix ];
}
`;

      const result = extractFromSource('configuration.nix', code);
      const importRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName);

      expect(importRefs).toEqual(['./hardware.nix', '../common', './home.nix', './configuration.nix']);
      // The dynamic entry (inputs.foo.nixosModules.bar) must not create a ref.
      expect(importRefs).not.toContain('inputs.foo.nixosModules.bar');
    });

    it('should emit file imports for callPackage with a literal path and skip dynamic ones', () => {
      const code = `
{ pkgs, newScope }:
let
  hello = pkgs.callPackage ./pkgs/hello { };
  tools = pkgs.callPackages ../tools/all.nix { };
  dynamic = pkgs.callPackage pkgPath { };
in
{
  inherit hello tools dynamic;
}
`;

      const result = extractFromSource('overlay.nix', code);
      const importRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);

      expect(importRefs).toEqual(['./pkgs/hello', '../tools/all.nix']);
      // The call edge to callPackage itself is still recorded.
      expect(calls).toContain('pkgs.callPackage');
    });

    it('should mark returned top-level Nix attrset members exported and keep let or nested attrs private', () => {
      const code = `
{ lib, stdenv }:
let
  localValue = 10;
in
{
  exported = localValue;
  package = { name }: stdenv.mkDerivation { inherit name; };
  nested = {
    privateNested = true;
  };
  inherit (lib) licenses;
}
`;

      const result = extractFromSource('default.nix', code);
      const node = (name: string) => result.nodes.find((n) => n.name === name);

      expect(node('localValue')?.isExported).toBe(false);
      expect(node('exported')?.isExported).toBe(true);
      expect(node('package')?.kind).toBe('function');
      expect(node('package')?.isExported).toBe(true);
      expect(node('privateNested')?.isExported).toBe(false);
      expect(node('licenses')?.isExported).toBe(true);
    });
  });
}
