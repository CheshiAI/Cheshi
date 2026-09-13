import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerLanguageDetectionTests(): void {


  describe('Language Detection', () => {
    it('should detect TypeScript files', () => {
      expect(detectLanguage('src/index.ts')).toBe('typescript');
      expect(detectLanguage('components/Button.tsx')).toBe('tsx');
    });

    it('should detect JavaScript files', () => {
      expect(detectLanguage('index.js')).toBe('javascript');
      expect(detectLanguage('App.jsx')).toBe('jsx');
      expect(detectLanguage('config.mjs')).toBe('javascript');
    });

    it('should detect Python files', () => {
      expect(detectLanguage('main.py')).toBe('python');
    });

    it('should detect Go files', () => {
      expect(detectLanguage('main.go')).toBe('go');
    });

    it('should detect Rust files', () => {
      expect(detectLanguage('lib.rs')).toBe('rust');
    });

    it('should detect Java files', () => {
      expect(detectLanguage('Main.java')).toBe('java');
    });

    it('should detect C files', () => {
      expect(detectLanguage('main.c')).toBe('c');
      expect(detectLanguage('utils.h')).toBe('c');
    });

    it('should detect C++ files', () => {
      expect(detectLanguage('main.cpp')).toBe('cpp');
      expect(detectLanguage('class.hpp')).toBe('cpp');
    });

    it('should detect C# files', () => {
      expect(detectLanguage('Program.cs')).toBe('csharp');
    });

    it('should detect PHP files', () => {
      expect(detectLanguage('index.php')).toBe('php');
    });

    it('should detect Ruby files', () => {
      expect(detectLanguage('app.rb')).toBe('ruby');
    });

    it('should detect Swift files', () => {
      expect(detectLanguage('ViewController.swift')).toBe('swift');
    });

    it('should detect Kotlin files', () => {
      expect(detectLanguage('MainActivity.kt')).toBe('kotlin');
      expect(detectLanguage('build.gradle.kts')).toBe('kotlin');
    });

    it('should detect Dart files', () => {
      expect(detectLanguage('main.dart')).toBe('dart');
    });

    it('should detect Objective-C files', () => {
      expect(detectLanguage('AppDelegate.m')).toBe('objc');
      expect(detectLanguage('ViewController.mm')).toBe('objc');
      const objcHeader = '@interface Foo : NSObject\n@end\n';
      expect(detectLanguage('Foo.h', objcHeader)).toBe('objc');
      expect(detectLanguage('stdio.h', '#ifndef STDIO_H\nvoid printf();\n#endif\n')).toBe('c');
    });

    it('should detect Metal shader files as C++ (#1121)', () => {
      expect(detectLanguage('Shaders.metal')).toBe('cpp');
      expect(isSourceFile('Renderer/Shaders.metal')).toBe(true);
    });

    it('should detect CUDA files as C++ (#387)', () => {
      expect(detectLanguage('kernels/scan.cu')).toBe('cpp');
      expect(detectLanguage('include/reduce.cuh')).toBe('cpp');
      expect(isSourceFile('csrc/flash_attn/softmax.cu')).toBe(true);
      expect(isSourceFile('include/block_reduce.cuh')).toBe(true);
    });

    it('should detect Erlang files', () => {
      expect(detectLanguage('src/my_server.erl')).toBe('erlang');
      expect(detectLanguage('include/records.hrl')).toBe('erlang');
      expect(detectLanguage('bin/release_tool.escript')).toBe('erlang');
      // OTP app resource files route by full suffix — `.src` alone is too generic.
      expect(detectLanguage('src/myapp.app.src')).toBe('erlang');
      expect(detectLanguage('ebin/myapp.app')).toBe('erlang');
      expect(detectLanguage('legacy/module.src')).toBe('unknown');
      expect(isSourceFile('src/myapp.app.src')).toBe(true);
      expect(isSourceFile('ebin/myapp.app')).toBe(true);
      expect(isSourceFile('legacy/module.src')).toBe(false);
    });

    it('should detect Solidity files', () => {
      expect(detectLanguage('contracts/Vault.sol')).toBe('solidity');
    });

    it('should detect Terraform files', () => {
      expect(detectLanguage('main.tf')).toBe('terraform');
      expect(detectLanguage('variables.tf')).toBe('terraform');
      expect(detectLanguage('terraform.tfvars')).toBe('terraform');
      expect(detectLanguage('versions.tofu')).toBe('terraform');
    });

    it('should detect ArkTS files', () => {
      expect(detectLanguage('entry/src/main/ets/pages/Index.ets')).toBe('arkts');
      // Plain `.ts` in a HarmonyOS project is still TypeScript.
      expect(detectLanguage('entry/src/main/ets/common/utils.ts')).toBe('typescript');
    });

    it('should detect Nix files', () => {
      expect(detectLanguage('default.nix')).toBe('nix');
      expect(detectLanguage('pkgs/development/tools/misc/codegraph/default.nix')).toBe('nix');
      expect(isSourceFile('default.nix')).toBe(true);
    });

    it('should detect a .h whose only C++ signal is an export-macro class as cpp', () => {
      // Lean Unreal-Engine style header: the class is annotated with an export
      // macro and carries no explicit `public:`/`virtual`/`namespace`/`template`,
      // so the macro-blind `class\s+\w+\s*[:{]` branch alone can't see it. It must
      // still detect as C++ — otherwise the C extractor (classTypes: []) drops the
      // class definition entirely. (#1093 follow-up)
      const macroClassHeader = `#pragma once
#include "CoreMinimal.h"

UCLASS()
class ENGINE_API UNetConnectionRepControl : public UObject
{
\tGENERATED_BODY()
\tbool IsRepControlEnable() const;
};
`;
      expect(detectLanguage('NetConnectionRepControl.h', macroClassHeader)).toBe('cpp');
      // Macro class with no base clause, brace on the next line, still C++.
      expect(detectLanguage('Foo.h', 'MYMODULE_API_DECL\nclass MYMODULE_API FFoo\n{\n\tint X;\n};\n')).toBe('cpp');
      // Export-macro struct with inheritance is likewise C++-only.
      expect(detectLanguage('Bar.h', 'struct ENGINE_API FBar : public FBase {};\n')).toBe('cpp');
      // Guard: a genuine C header must NOT be dragged to C++ by the new branch.
      expect(detectLanguage('cfoo.h', '#ifndef CFOO_H\nstruct Point { int x; int y; };\nvoid f(struct Point p);\n#endif\n')).toBe('c');
    });

    it('should return unknown for unsupported extensions', () => {
      expect(detectLanguage('styles.css')).toBe('unknown');
      expect(detectLanguage('data.json')).toBe('unknown');
    });
  });
}
