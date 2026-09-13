import { CodeGraph } from '../src';
import {
  registerCChainedStaticFactoryCallResolution645608MechanismTests,
} from './resolution.c-chained-static-factory-call-resolution-645-608-mechanism.cases';
import {
  registerCNamespaceQualifiedStaticMethodCallsToOutOfLineDefinitions1Tests,
} from './resolution.c-namespace-qualified-static-method-calls-to-out-of-line-definitions-1.cases';
import {
  registerDartChainedStaticFactoryFactoryConstructorCallResolution64560Tests,
} from './resolution.dart-chained-static-factory-factory-constructor-call-resolution-645-60.cases';
import { registerImportResolverTests } from './resolution.import-resolver.cases';
import { registerIntegrationTestsTests } from './resolution.integration-tests.cases';
import { registerLocalVariableReceiverTypeInference1108Tests } from './resolution.local-variable-receiver-type-inference-1108.cases';
import { registerNameMatcherTests } from './resolution.name-matcher.cases';
import { registerPhpIncludeResolutionTests } from './resolution.php-include-resolution.cases';
import { registerReExportChainFollowingTests } from './resolution.re-export-chain-following.cases';
import { registerSameNameMethodDisambiguation1079Tests } from './resolution.same-name-method-disambiguation-1079.cases';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerResolutionModuleTests(): void {


  describe('Resolution Module', () => {
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      // Create temp directory
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-test-'));
    });

    afterEach(() => {
      // Clean up
      if (cg) {
        cg.close();
      } else if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    });

    registerNameMatcherTests();

    registerImportResolverTests();

    registerIntegrationTestsTests({
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
      get cg() { return cg; }, set cg(value) { cg = value; },
    });

    registerSameNameMethodDisambiguation1079Tests({
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
      get cg() { return cg; }, set cg(value) { cg = value; },
    });

    registerLocalVariableReceiverTypeInference1108Tests({
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
      get cg() { return cg; }, set cg(value) { cg = value; },
    });

    registerReExportChainFollowingTests({
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
      get cg() { return cg; }, set cg(value) { cg = value; },
    });

    registerCNamespaceQualifiedStaticMethodCallsToOutOfLineDefinitions1Tests({
      get cg() { return cg; }, set cg(value) { cg = value; },
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
    });

    registerPhpIncludeResolutionTests({
      get cg() { return cg; }, set cg(value) { cg = value; },
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
    });

    registerCChainedStaticFactoryCallResolution645608MechanismTests({
      get cg() { return cg; }, set cg(value) { cg = value; },
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
    });

    registerDartChainedStaticFactoryFactoryConstructorCallResolution64560Tests({
      get cg() { return cg; }, set cg(value) { cg = value; },
      get tempDir() { return tempDir; }, set tempDir(value) { tempDir = value; },
    });

    describe('Pascal/Delphi chained static-factory call resolution (#645/#608 mechanism)', () => {
      function callerNamesOf(qualifiedName: string): string[] {
        const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
        if (!target) return [];
        const names = cg
          .getIncomingEdges(target.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => cg.getNode(e.source)?.name)
          .filter((n): n is string => !!n);
        return [...new Set(names)].sort();
      }
      function isCalled(qn: string): boolean {
        const t = cg.getNodesByKind('method').find((n) => n.qualifiedName === qn);
        return !!t && cg.getIncomingEdges(t.id).some((e) => e.kind === 'calls');
      }

      it('resolves a chained factory call TFoo.GetInstance().DoIt() via the return type, never a same-named decoy', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TBar = class
    procedure DoIt;
  end;
  TDecoy = class
    procedure DoIt;
  end;
  TFoo = class
    class function GetInstance: TBar;
  end;
implementation
procedure TBar.DoIt; begin end;
procedure TDecoy.DoIt; begin end;
class function TFoo.GetInstance: TBar; begin Result := nil; end;
procedure Run;
begin
  TFoo.GetInstance().DoIt();
end;
end.
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        expect(isCalled('TBar::DoIt')).toBe(true);
        expect(isCalled('TDecoy::DoIt')).toBe(false);
      });

      it('resolves a constructor chain TFoo.Create().Configure() on the constructed class', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TFoo = class
    constructor Create;
    procedure Configure;
  end;
  TDecoy = class
    procedure Configure;
  end;
implementation
constructor TFoo.Create; begin end;
procedure TFoo.Configure; begin end;
procedure TDecoy.Configure; begin end;
procedure Run;
begin
  TFoo.Create().Configure();
end;
end.
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        // A constructor returns its own class (no `: TBar` annotation), so Configure
        // resolves on TFoo, not the same-named decoy.
        expect(isCalled('TFoo::Configure')).toBe(true);
        expect(isCalled('TDecoy::Configure')).toBe(false);
      });

      it('resolves a typecast chain TFoo(x).DoIt() on the cast type', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TFoo = class
    procedure DoIt;
  end;
  TDecoy = class
    procedure DoIt;
  end;
implementation
procedure TFoo.DoIt; begin end;
procedure TDecoy.DoIt; begin end;
procedure Run(obj: TObject);
begin
  TFoo(obj).DoIt();
end;
end.
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        expect(isCalled('TFoo::DoIt')).toBe(true);
        expect(isCalled('TDecoy::DoIt')).toBe(false);
      });

      it('creates NO edge when the factory return type lacks the method (silent miss)', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TBar = class
  end;
  TOther = class
    procedure OnlyOther;
  end;
  TFoo = class
    class function GetInstance: TBar;
  end;
implementation
procedure TOther.OnlyOther; begin end;
class function TFoo.GetInstance: TBar; begin Result := nil; end;
procedure Run;
begin
  TFoo.GetInstance().OnlyOther();
end;
end.
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        // TBar has no OnlyOther — must not mis-attach to the same-named TOther::OnlyOther.
        expect(isCalled('TOther::OnlyOther')).toBe(false);
      });

      it('extracts paren-less method calls (Pascal lets a no-arg method drop its parens)', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TFoo = class
    procedure DoThing;
    procedure Reset;
  end;
implementation
procedure TFoo.DoThing; begin end;
procedure TFoo.Reset; begin end;
procedure Run(f: TFoo);
begin
  f.DoThing;
  f.Reset;
end;
end.
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        expect(isCalled('TFoo::DoThing')).toBe(true);
        expect(isCalled('TFoo::Reset')).toBe(true);
      });

      it('resolves a PAREN-LESS chained factory call TFoo.GetInstance.DoIt via the return type', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TBar = class
    procedure DoIt;
  end;
  TDecoy = class
    procedure DoIt;
  end;
  TFoo = class
    class function GetInstance: TBar;
  end;
implementation
procedure TBar.DoIt; begin end;
procedure TDecoy.DoIt; begin end;
class function TFoo.GetInstance: TBar; begin Result := nil; end;
procedure Run;
begin
  TFoo.GetInstance.DoIt;
end;
end.
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        expect(isCalled('TBar::DoIt')).toBe(true);
        expect(isCalled('TDecoy::DoIt')).toBe(false);
      });

      it('does NOT turn a property write/read into a call edge (only statement-level dots are calls)', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TFoo = class
    function GetValue: Integer;
    procedure SetValue(v: Integer);
    property Value: Integer read GetValue write SetValue;
  end;
implementation
function TFoo.GetValue: Integer; begin Result := 0; end;
procedure TFoo.SetValue(v: Integer); begin end;
procedure Run(f: TFoo);
var x: Integer;
begin
  f.Value := 5;
  x := f.Value;
end;
end.
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        // A property read/write is a bare dot in assignment position, not a statement,
        // so it must not be mis-extracted as a call to the property's getter/setter.
        expect(isCalled('TFoo::GetValue')).toBe(false);
        expect(isCalled('TFoo::SetValue')).toBe(false);
      });

      it('attributes an implementation-only free procedure\'s calls to the procedure, not the file', async () => {
        fs.writeFileSync(
          path.join(tempDir, 'main.pas'),
          `unit Main;
interface
type
  TTgt = class
    procedure Hit;
  end;
  TFoo = class
    procedure DoStuff;
  end;
implementation
procedure TTgt.Hit; begin end;
procedure TFoo.DoStuff; var t: TTgt; begin t.Hit; end;
procedure Helper; var t: TTgt; begin t.Hit; end;
`
        );
        cg = await CodeGraph.init(tempDir, { index: true });
        // `Helper` is implementation-only (no interface decl, not a method), but its
        // body's call must attribute to `Helper`, not the file/module — alongside the
        // method `DoStuff`.
        expect(callerNamesOf('TTgt::Hit')).toEqual(['DoStuff', 'Helper']);
      });
    });

    describe('Nix path import resolution', () => {
      function fileNode(filePath: string) {
        return cg.getNodesByKind('file').find((n) => n.filePath === filePath);
      }

      function importedFilePaths(fromFile: string): string[] {
        const source = fileNode(fromFile);
        expect(source, `${fromFile} file node`).toBeDefined();
        return cg
          .getOutgoingEdges(source!.id)
          .filter((edge) => edge.kind === 'imports')
          .map((edge) => cg.getNodesByKind('file').find((n) => n.id === edge.target)?.filePath)
          .filter((filePath): filePath is string => Boolean(filePath))
          .sort();
      }

      it('resolves relative Nix imports to indexed file nodes', async () => {
        fs.mkdirSync(path.join(tempDir, 'core'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'core', 'ports.nix'), '{ http = 80; https = 443; }');
        fs.writeFileSync(
          path.join(tempDir, 'data', 'postgresql.nix'),
          `let
  ports = import ../core/ports.nix;
in
{
  port = ports.https;
}
`
        );

        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        expect(importedFilePaths('data/postgresql.nix')).toEqual(['core/ports.nix']);
      });

      it('resolves Nix directory imports through default.nix and deduplicates called imports', async () => {
        fs.mkdirSync(path.join(tempDir, 'dir'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'dir', 'default.nix'), '{ value = 1; }');
        fs.writeFileSync(path.join(tempDir, 'x.nix'), '{ value = 2; }');
        fs.writeFileSync(
          path.join(tempDir, 'main.nix'),
          `let
  dir = import ./dir;
  x = import ./x.nix {};
in
{
  inherit dir x;
}
`
        );

        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        expect(importedFilePaths('main.nix')).toEqual(['dir/default.nix', 'x.nix']);
      });

      it('resolves NixOS module imports lists and callPackage paths to file nodes', async () => {
        fs.mkdirSync(path.join(tempDir, 'modules'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'common'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'pkgs', 'hello'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'modules', 'users.nix'), '{ users.users.demo.isNormalUser = true; }');
        fs.writeFileSync(path.join(tempDir, 'common', 'default.nix'), '{ time.timeZone = "UTC"; }');
        fs.writeFileSync(
          path.join(tempDir, 'pkgs', 'hello', 'default.nix'),
          '{ stdenv }: stdenv.mkDerivation { pname = "hello"; }'
        );
        fs.writeFileSync(
          path.join(tempDir, 'configuration.nix'),
          `{ config, pkgs, ... }:
{
  imports = [ ./modules/users.nix ./common ];
  environment.systemPackages = [ (pkgs.callPackage ./pkgs/hello { }) ];
}
`
        );

        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        expect(importedFilePaths('configuration.nix')).toEqual([
          'common/default.nix',
          'modules/users.nix',
          'pkgs/hello/default.nix',
        ]);
      });

      it('never resolves another language\'s calls into nix bindings', async () => {
        // Nix bindings are not linkable symbols from any other language —
        // interop is eval/CLI. Without the target-side gate, a Python script's
        // bare `resolve(...)` exact-matches a module's `resolve = ...` binding.
        fs.writeFileSync(
          path.join(tempDir, 'helpers.nix'),
          `let
  resolve = x: x;
in
{
  inherit resolve;
}
`
        );
        fs.writeFileSync(path.join(tempDir, 'tool.py'), 'def main():\n    return resolve("target")\n');

        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        const nixNodeIds = new Set(
          cg.getNodesByKind('variable').filter((n) => n.language === 'nix').map((n) => n.id)
        );
        const pyFns = cg.getNodesByKind('function').filter((n) => n.language === 'python');
        expect(pyFns.length).toBeGreaterThan(0);
        const crossEdges = pyFns.flatMap((f) => cg.getOutgoingEdges(f.id)).filter((e) => nixNodeIds.has(e.target));
        expect(crossEdges).toEqual([]);
      });

      it('never cross-links Nix calls by bare name across files (lexical scope only)', async () => {
        // Both modules `inherit (lib) mkOption` — the nixpkgs idiom. A call to
        // mkOption in one file must NOT resolve to the other file's inherit
        // binding: Nix has no ambient cross-file namespace, so any such edge is
        // wrong by construction. Same-file bindings still resolve.
        fs.writeFileSync(
          path.join(tempDir, 'alpha.nix'),
          `{ lib, ... }:
let
  inherit (lib) mkOption;
  mkPort = default: mkOption { inherit default; };
in
{
  options.alpha.port = mkPort 8080;
}
`
        );
        fs.writeFileSync(
          path.join(tempDir, 'beta.nix'),
          `{ lib, ... }:
let
  inherit (lib) mkOption;
in
{
  options.beta.enable = mkOption { default = false; };
}
`
        );

        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        const crossFileCalls = cg
          .getNodesByKind('file')
          .flatMap((f) => cg.getOutgoingEdges(f.id))
          .concat(
            cg.getNodesByKind('function').flatMap((f) => cg.getOutgoingEdges(f.id)),
            cg.getNodesByKind('variable').flatMap((v) => cg.getOutgoingEdges(v.id))
          )
          .filter((e) => e.kind === 'calls')
          .map((e) => {
            const src = cg.getNode(e.source);
            const tgt = cg.getNode(e.target);
            return { from: src?.filePath, to: tgt?.filePath, name: tgt?.name };
          });

        // No calls edge may cross files by bare-name matching.
        expect(crossFileCalls.filter((e) => e.from !== e.to)).toEqual([]);
        // The same-file chain still resolves: mkPort's mkOption call hits
        // alpha.nix's own inherit binding.
        const sameFile = crossFileCalls.filter((e) => e.from === e.to && e.name === 'mkOption');
        expect(sameFile.length).toBeGreaterThan(0);
        expect(sameFile.every((e) => e.from === 'alpha.nix' || e.from === 'beta.nix')).toBe(true);
      });

      it('does not resolve Nix angle-bracket, attribute, or variable imports as project file edges', async () => {
        fs.writeFileSync(path.join(tempDir, 'nixpkgs.nix'), '{ bogus = true; }');
        fs.writeFileSync(path.join(tempDir, 'selectedPath.nix'), '{ bogus = true; }');
        fs.writeFileSync(
          path.join(tempDir, 'main.nix'),
          `let
  pkgs = import <nixpkgs> {};
  fromSources = import sources.nixpkgs {};
  dynamic = import selectedPath;
in
{
  inherit pkgs fromSources dynamic;
}
`
        );

        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        expect(importedFilePaths('main.nix')).toEqual([]);
      });
    });
  });
}
