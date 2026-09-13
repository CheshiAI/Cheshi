import { extractFromSource } from '../src/extraction';
import {
  blankCLeadingAttrMacros,
  blankCppInlineMacros,
  recoverMangledCppName,
  stripCppTemplateArgs,
} from '../src/extraction/languages/c-cpp';
import { registerCudaExtraction387Tests } from './extraction.cuda-extraction-387.cases';
import { registerMetalShaderExtraction1121Tests } from './extraction.metal-shader-extraction-1121.cases';
import { registerPhpImportsTests } from './extraction.php-imports.cases';
import { registerTypescriptJavascriptImportsTests } from './extraction.typescript-javascript-imports.cases';
import { describe, expect, it } from 'bun:test';

export function registerImportExtractionTests(): void {


  describe('Import Extraction', () => {

    registerTypescriptJavascriptImportsTests();

    registerPhpImportsTests();

    registerMetalShaderExtraction1121Tests();

    registerCudaExtraction387Tests();

    describe('C++ explicit operator-call refs (#1247)', () => {
      // tree-sitter-cpp can't parse an operator_name in field position:
      // `a.operator+(b)` yields `call_expression(function: identifier «a»,
      // ERROR(operator_name), argument_list)` instead of a field_expression
      // callee, so the emitted ref was just the receiver (`a`) and the call never
      // resolved. The extractor recovers the operator_name from the ERROR child
      // and emits `<receiver>.operator+` like any other member call.
      const HEADER = 'struct V {\n  V operator+(const V& o) const;\n  V operator[](int i) const;\n  V operator()(int i) const;\n  bool operator==(const V& o) const;\n  int get() const;\n};\n';
      const callRefsOf = (body: string) =>
        extractFromSource('op.cpp', HEADER + body)
          .unresolvedReferences.filter((r) => r.referenceKind === 'calls')
          .map((r) => r.referenceName);

      it('recovers receiver.operator+ from the explicit call form', () => {
        expect(callRefsOf('V f(const V& a, const V& b) { return a.operator+(b); }\n')).toContain('a.operator+');
      });

      it('recovers pointer receivers (p->operator+ → p.operator+)', () => {
        expect(callRefsOf('V f(const V* p, const V& b) { return p->operator+(b); }\n')).toContain('p.operator+');
      });

      it('recovers subscript, call, and comparison operator forms', () => {
        const refs = callRefsOf(
          'V f1(const V& a) { return a.operator[](3); }\n' +
          'V f2(V& a) { return a.operator()(1); }\n' +
          'bool f3(const V& a, const V& b) { return a.operator==(b); }\n'
        );
        expect(refs).toContain('a.operator[]');
        expect(refs).toContain('a.operator()');
        expect(refs).toContain('a.operator==');
      });

      it('normalizes spaced call-site operator names to the compact definition form', () => {
        // nlohmann/json calls `it.operator * ()` / `other.operator < (*this)`
        // while defining `operator*` / `operator<` compact.
        const refs = callRefsOf(
          'bool f(const V& a, const V& b) { return a.operator == (b); }\n' +
          'V g(const V& a) { return a.operator [] (3); }\n'
        );
        expect(refs).toContain('a.operator==');
        expect(refs).toContain('a.operator[]');
      });

      it('drops the ref for a complex receiver instead of guessing (no wrong edge)', () => {
        // `object->operator[](val)` through a member chain ending in a call —
        // the receiver type isn't inferable and a bare `operator[]` ref would
        // let exact-name matching guess among unrelated operators.
        const refs = callRefsOf(
          'struct W { V* obj(); };\n' +
          'V f(W& w, const V& b) { return w.obj()->operator+(b); }\n'
        );
        expect(refs.some((r) => r.includes('operator+'))).toBe(false);
        expect(refs).toContain('w.obj'); // the inner call itself still refs normally
      });

      it('emits the bare operator name for a this-> receiver', () => {
        const refs = extractFromSource(
          'op.cpp',
          'struct V {\n  V operator+(const V& o) const;\n  V twice() const { return this->operator+(*this); }\n};\n'
        ).unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        expect(refs).toContain('operator+');
        expect(refs.some((r) => r.includes('this'))).toBe(false);
      });

      it('leaves plain member calls unchanged (control)', () => {
        expect(callRefsOf('int f(const V& a) { return a.get(); }\n')).toContain('a.get');
      });
    });

    describe('C++ macro-prefixed function names (#1093 follow-up)', () => {
      // An unknown inline-specifier macro before the return type
      // (`FORCEINLINE FString GetName(…)`) threw tree-sitter into error recovery:
      // the macro became the return type and — for a non-primitive return — the
      // return type was glued onto the name (`"FString GetName"`), so the function
      // was unfindable by name and its callers didn't link. `blankCppInlineMacros`
      // blanks the known UE inline macros before parsing (offset-preserving), the
      // same recover-don't-drop approach as the macro-annotated-class fix. Pervasive
      // in Unreal Engine (`FORCEINLINE`).
      const infoOf = (code: string) =>
        extractFromSource('m.cpp', code).nodes
          .filter((n) => n.kind === 'method' || n.kind === 'function')
          .map((n) => ({ name: n.name, ret: n.returnType }));

      it('recovers the real name AND return type of a FORCEINLINE function', () => {
        expect(infoOf('static FORCEINLINE FString GetName(int V) { return H(V); }')).toEqual([
          { name: 'GetName', ret: 'FString' },
        ]);
      });

      it('handles the templated UE helper shape (GetEnumerationToString)', () => {
        const names = infoOf(
          'template <typename E> static FORCEINLINE FString GetEnumerationToString(const E V) { return H(V); }'
        ).map((x) => x.name);
        expect(names).toContain('GetEnumerationToString');
      });

      it('handles FORCENOINLINE / FORCEINLINE_DEBUGGABLE, methods, void, and reference returns', () => {
        expect(infoOf('FORCENOINLINE FString A(int V){return H(V);}').map((x) => x.name)).toContain('A');
        expect(infoOf('FORCEINLINE_DEBUGGABLE FString B(int V){return H(V);}').map((x) => x.name)).toContain('B');
        expect(infoOf('struct S { FORCEINLINE FString GetName(int V) { return H(V); } };').map((x) => x.name)).toContain('GetName');
        expect(infoOf('static FORCEINLINE void DoThing(int V) { H(V); }').map((x) => x.name)).toContain('DoThing');
        expect(infoOf('static FORCEINLINE const FString& GetRef(int V) { return H(V); }').map((x) => x.name)).toContain('GetRef');
      });

      it('handles common third-party inline macros (pugixml, Godot, Boost, generic)', () => {
        // pugixml: PUGI__FN before the return type; PUGIXML_FUNCTION (linkage)
        // between the return type and the name — both recovered.
        expect(infoOf('PUGI__FN void* default_allocate(size_t n) { return H(n); }').map((x) => x.name)).toContain('default_allocate');
        expect(infoOf('PUGI__FN_NO_INLINE bool strequal(const char_t* a) { return H(a); }').map((x) => x.name)).toContain('strequal');
        expect(infoOf('std::string PUGIXML_FUNCTION as_utf8(const wchar_t* s) { return H(s); }').map((x) => x.name)).toContain('as_utf8');
        // Godot / Boost / generic inline hints
        expect(infoOf('_FORCE_INLINE_ String get_name() const { return H(); }').map((x) => x.name)).toContain('get_name');
        expect(infoOf('_ALWAYS_INLINE_ Vector2 get_pos() { return H(); }').map((x) => x.name)).toContain('get_pos');
        expect(infoOf('BOOST_FORCEINLINE result_type call() { return H(); }').map((x) => x.name)).toContain('call');
        expect(infoOf('ALWAYS_INLINE MyType compute() { return H(); }').map((x) => x.name)).toContain('compute');
      });

      it('leaves ordinary functions and real all-caps return types untouched (controls)', () => {
        expect(infoOf('FString GetName(int V) { return H(V); }')).toEqual([{ name: 'GetName', ret: 'FString' }]);
        // A real all-caps type that is NOT a listed inline macro stays the return type.
        expect(infoOf('HRESULT DoIt(int V) { return H(V); }')).toEqual([{ name: 'DoIt', ret: 'HRESULT' }]);
      });

      it('blankCppInlineMacros preserves offsets and only touches specifier-position macros', () => {
        // Blanked with equal-length spaces (byte offsets preserved).
        expect(blankCppInlineMacros('FORCEINLINE FString F()')).toBe('            FString F()');
        expect(blankCppInlineMacros('FORCEINLINE FString F()')).toHaveLength('FORCEINLINE FString F()'.length);
        // Not in specifier position → untouched: string literals, expressions,
        // longer word (`FORCEINLINE_COUNT`), and the fast path.
        expect(blankCppInlineMacros('const char* s = "FORCEINLINE";')).toBe('const char* s = "FORCEINLINE";');
        expect(blankCppInlineMacros('x = FORCEINLINE + 1;')).toBe('x = FORCEINLINE + 1;');
        expect(blankCppInlineMacros('int FORCEINLINE_COUNT = 3;')).toBe('int FORCEINLINE_COUNT = 3;');
        expect(blankCppInlineMacros('no macros here')).toBe('no macros here');
      });
    });

    describe('C++ universal macro-mangled name recovery', () => {
      // Curated pre-parse blanking can't list every library's inline macro, so a
      // post-parse salvage recovers the real function name from ANY leftover
      // `MACRO Ret name(…)` mangle — no list needed. It only ever touches an
      // already-mangled name, so it can't corrupt a clean one.
      const namesOf = (code: string, file = 's.cpp') =>
        extractFromSource(file, code).nodes
          .filter((n) => n.kind === 'method' || n.kind === 'function')
          .map((n) => n.name);

      it('recovers the name from a completely unknown macro (no list entry)', () => {
        expect(namesOf('WEBKIT_EXPORT WTFString computeThing(int x) { return H(x); }')).toContain('computeThing');
        expect(namesOf('SOMELIB_INLINE MyResult doWork(int x) { return H(x); }')).toContain('doWork');
        expect(namesOf('MZ_FORCEINLINE char_t* to_str(double v) { return H(v); }')).toContain('to_str');
      });

      it('recoverMangledCppName only touches already-mangled names, with guards', () => {
        // Recovered:
        expect(recoverMangledCppName('WTFString computeThing')).toBe('computeThing');
        expect(recoverMangledCppName('char_t* to_str(double v)')).toBe('to_str');
        expect(recoverMangledCppName('unspecified_bool_type() const')).toBe('unspecified_bool_type');
        // Left unchanged — clean names, operators, destructors, the `Ret (name)`
        // idiom, and non-identifier tails:
        expect(recoverMangledCppName('computeThing')).toBe('computeThing');
        expect(recoverMangledCppName('operator EALSMovementState')).toBe('operator EALSMovementState');
        expect(recoverMangledCppName('~Widget')).toBe('~Widget');
        expect(recoverMangledCppName('bool (likely)')).toBe('bool (likely)');
        expect(recoverMangledCppName('void (free)')).toBe('void (free)');
        expect(recoverMangledCppName('QDockWidget *')).toBe('QDockWidget *');
      });

      it('does not disturb clean C++ names or non-C++ (Kotlin backtick) names', () => {
        expect(namesOf('int foo(int x) { return x; }')).toEqual(['foo']);
        // Kotlin backtick identifiers legitimately contain spaces; the salvage is
        // C/C++-only, so they are untouched.
        const kt = extractFromSource('T.kt', 'class T {\n  fun `decode simple cert`() { }\n}').nodes
          .filter((n) => n.kind === 'method' || n.kind === 'function')
          .map((n) => n.name);
        expect(kt).toContain('`decode simple cert`');
      });

      it('curated list now also covers Qt / Folly / Abseil / LLVM / V8 / Eigen / rapidjson (full recovery)', () => {
        const info = (c: string) =>
          extractFromSource('x.cpp', c).nodes
            .filter((n) => n.kind === 'method' || n.kind === 'function')
            .map((n) => ({ name: n.name, ret: n.returnType }));
        expect(info('FOLLY_ALWAYS_INLINE Str f(int x) { return H(x); }')).toEqual([{ name: 'f', ret: 'Str' }]);
        expect(namesOf('Q_INVOKABLE void onClicked() { H(); }')).toContain('onClicked');
        expect(namesOf('ABSL_ATTRIBUTE_ALWAYS_INLINE int hash(int x) { return H(x); }')).toContain('hash');
        expect(namesOf('EIGEN_STRONG_INLINE Scalar dot(const V& v) { return H(v); }')).toContain('dot');
        expect(namesOf('V8_INLINE MaybeLocal Get(int i) { return H(i); }')).toContain('Get');
        expect(namesOf('RAPIDJSON_FORCEINLINE bool Parse(const char* s) { return H(s); }')).toContain('Parse');
      });

      it('curated list spans the broader ecosystem (Mozilla, GLM, Bullet, OpenCV, Skia, EASTL, protobuf, fmt, Windows conventions)', () => {
        const info = (c: string) =>
          extractFromSource('x.cpp', c).nodes
            .filter((n) => n.kind === 'method' || n.kind === 'function')
            .map((n) => ({ name: n.name, ret: n.returnType }));
        expect(info('MOZ_ALWAYS_INLINE Value get(int i) { return H(i); }')).toEqual([{ name: 'get', ret: 'Value' }]);
        expect(info('GLM_FUNC_QUALIFIER vec3 cross(const vec3& a) { return H(a); }')).toEqual([{ name: 'cross', ret: 'vec3' }]);
        expect(info('SIMD_FORCE_INLINE btScalar dot(const btVector3& v) const { return H(v); }')).toEqual([{ name: 'dot', ret: 'btScalar' }]);
        expect(info('CV_INLINE Mat clone() const { return H(); }')).toEqual([{ name: 'clone', ret: 'Mat' }]);
        expect(namesOf('PROTOBUF_ALWAYS_INLINE int size() const { return H(); }')).toContain('size');
        expect(namesOf('FMT_CONSTEXPR auto parse(int x) { return H(x); }')).toContain('parse');
        expect(namesOf('SK_ALWAYS_INLINE SkScalar width() const { return H(); }')).toContain('width');
        expect(namesOf('EA_FORCE_INLINE size_type size() const { return H(); }')).toContain('size');
        // Windows calling-convention macros sit between return type and name; the
        // macro is blanked so the real return type survives.
        expect(info('HRESULT WINAPI CreateThing(int x) { return H(x); }')).toEqual([{ name: 'CreateThing', ret: 'HRESULT' }]);
        expect(info('ULONG STDMETHODCALLTYPE AddRef() { return H(); }')).toEqual([{ name: 'AddRef', ret: 'ULONG' }]);
      });
    });

    describe('C++ templated base-class inheritance (#1043)', () => {
      // Inheriting from a template (`class D : public Base<int>`) recorded the base
      // ref as the full instantiation `Base<int>`, which never name-matched the
      // template indexed as the bare node `Base`. The `<…>` args are stripped so the
      // `extends` reference matches.
      it('strips template args from a templated base so the extends ref is the bare name', () => {
        const code = `
template<typename T> class Base {};
template<typename D> class CRTPBase {};
namespace ns { template<typename T> class Tpl {}; }
class Plain {};

class Widget : public Base<int> {};
class App : public CRTPBase<App> {};
class Q : public ns::Tpl<int> {};
class Both : public Base<char>, public Plain {};
`;
        const extendsRefs = extractFromSource('f.cpp', code).unresolvedReferences.filter(
          (r) => r.referenceKind === 'extends'
        );
        const names = extendsRefs.map((r) => r.referenceName);

        // Templated bases carry the bare name, NOT the `<…>` instantiation.
        expect(names).toContain('Base'); // from Base<int> / Base<char>
        expect(names).toContain('CRTPBase'); // from CRTPBase<App> (CRTP)
        expect(names).toContain('ns::Tpl'); // qualified head preserved, args dropped
        expect(names).toContain('Plain'); // non-templated base unchanged
        // No reference still carries angle brackets.
        expect(names.find((n) => n.includes('<'))).toBeUndefined();
      });

      it('stripCppTemplateArgs removes balanced <…> at any depth and is a no-op without them', () => {
        expect(stripCppTemplateArgs('Base<int>')).toBe('Base');
        expect(stripCppTemplateArgs('ns::Tpl<int>')).toBe('ns::Tpl');
        expect(stripCppTemplateArgs('ns::Tpl<Foo<int>>')).toBe('ns::Tpl'); // nested
        expect(stripCppTemplateArgs('Outer<int>::Inner')).toBe('Outer::Inner'); // mid-name
        expect(stripCppTemplateArgs('Base')).toBe('Base'); // no-op
        expect(stripCppTemplateArgs('ns::Plain')).toBe('ns::Plain'); // no-op qualified
      });
    });

    describe('C leading attribute macro before typedef return type (#1211)', () => {
      // `SEC_ATTR UINT32 LostName(VOID)` — tree-sitter's C grammar reads the
      // unknown macro as the type, the typedef'd return as the declarator, and
      // stores the PARAMETER LIST as the function name ("(VOID)"). The
      // structural pre-parse blank recovers the definition; the issue's whole
      // isolation table is pinned here.
      it("recovers the issue's full isolation table under their real names", () => {
        const code = `#define SEC_ATTR __attribute__((section(".init")))
typedef unsigned int UINT32;
#define VOID void

SEC_ATTR VOID   GoodName(VOID)  { }
SEC_ATTR UINT32 LostName(VOID)  { return 0; }
UINT32 NoAttr(void) { return 0; }
SEC_ATTR int BuiltinRet(void) { return 0; }
__attribute__((section(".init"))) UINT32 RawAttr(void) { return 0; }
SEC_ATTR UINT32 OneNamedArg(UINT32 x) { return x; }
SEC_ATTR UINT32* PtrRet(VOID) { return 0; }
`;
        const result = extractFromSource('attrs.c', code);
        const fns = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
        expect(fns).toEqual(
          expect.arrayContaining([
            'GoodName', 'LostName', 'NoAttr', 'BuiltinRet', 'RawAttr', 'OneNamedArg', 'PtrRet',
          ])
        );
        // The bug shape: a parameter list stored as a name.
        expect(fns.find((n) => n.includes('('))).toBeUndefined();
      });

      it('blankCLeadingAttrMacros only touches the MACRO-ret-name-( definition shape', () => {
        // Blanked: the definition shape (offset-preserving).
        expect(blankCLeadingAttrMacros('SEC_ATTR UINT32 f(void) {}')).toBe(
          '         UINT32 f(void) {}'
        );
        // Untouched: a plain typedef'd return with ONE identifier before `(`.
        expect(blankCLeadingAttrMacros('UINT32 helper(void) {}')).toBe('UINT32 helper(void) {}');
        // Untouched: an ALL-CAPS function CALL at line start.
        expect(blankCLeadingAttrMacros('MY_ASSERT(x);')).toBe('MY_ASSERT(x);');
        // Untouched: #define lines (start with #, not line-leading CAPS).
        const def = '#define SEC_ATTR __attribute__((section(".init")))';
        expect(blankCLeadingAttrMacros(def)).toBe(def);
        // Untouched: multi-word builtin returns (the grammar keeps the name there).
        expect(blankCLeadingAttrMacros('SEC_ATTR unsigned int f(void) {}')).toBe(
          'SEC_ATTR unsigned int f(void) {}'
        );
        // Untouched: mid-line uses.
        expect(blankCLeadingAttrMacros('x = SEC_ATTR UINT32 y(z);')).toBe(
          'x = SEC_ATTR UINT32 y(z);'
        );
      });
    });

    describe('C++ out-of-line template method receivers (#1286)', () => {
      // `template<typename T> T Box<T>::get()` used to store qualified_name
      // `Box<T>::get` — the `<T>` qualifier never matched the class node indexed
      // as `Box`, and long multi-line parameter lists could push qualified_name
      // past NAME_MAX. Inline definitions of the same method produce `Box::get`,
      // so the out-of-line form must normalize to the identical name.
      it('strips the template parameter list from the receiver qualifier', () => {
        const code = `template <typename T>
class Box {
public:
    T get() const;
    void set(T v);
private:
    T value;
};

template <typename T> T Box<T>::get() const { return value; }
template <typename T> void Box<T>::set(T v) { value = v; }
`;
        const result = extractFromSource('box.cpp', code);
        expect(result.errors).toHaveLength(0);
        const methods = result.nodes.filter((n) => n.kind === 'method');
        const qns = methods.map((n) => n.qualifiedName).sort();
        // Out-of-line definitions carry the SAME qualifier as the class node.
        expect(qns).toContain('Box::get');
        expect(qns).toContain('Box::set');
        expect(qns.find((q) => q?.includes('<'))).toBeUndefined();
        // Names themselves stay clean.
        expect(methods.map((n) => n.name).sort()).toEqual(expect.arrayContaining(['get', 'set']));
      });

      it('multi-line template parameter lists cannot leak into qualified_name (NAME_MAX overflow shape)', () => {
        // The ICU capi_helper.h shape: enormous multi-line parameter names made
        // qualified_name 272 bytes (> NAME_MAX 255) including embedded newlines.
        const code = `template <typename CType,
          typename CPPType,
          int32_t kMagicValidationSentinelConstantForTheHelperTemplateClassInstanceGuardLong>
class ApiHelper {
public:
    CPPType* validate();
};

template <typename CType,
          typename CPPType,
          int32_t kMagicValidationSentinelConstantForTheHelperTemplateClassInstanceGuardLong>
CPPType* ApiHelper<CType,
                   CPPType,
                   kMagicValidationSentinelConstantForTheHelperTemplateClassInstanceGuardLong>::validate() {
    return nullptr;
}
`;
        const result = extractFromSource('capi_helper.h', code);
        const validate = result.nodes.find((n) => n.kind === 'method' && n.name === 'validate' && n.qualifiedName?.includes('::'));
        expect(validate).toBeDefined();
        expect(validate!.qualifiedName).toBe('ApiHelper::validate');
        expect(validate!.qualifiedName!.length).toBeLessThan(255);
        expect(validate!.qualifiedName).not.toMatch(/[<>\n]/);
      });
    });

    describe('C++ stack-allocation construction (#1035)', () => {
      // `Calculator calc(0)` (direct-init) and `Widget w{1, 2}` (brace-init) carry
      // the constructor args directly on the declarator — no call/new node — so
      // they emitted no constructor reference, unlike heap `new Calculator(0)`. An
      // `instantiates` ref to the constructed type is now emitted for both.
      const instNames = (code: string) =>
        extractFromSource('f.cpp', `void run() {\n${code}\n}`)
          .unresolvedReferences.filter((r) => r.referenceKind === 'instantiates')
          .map((r) => r.referenceName);

      it('emits an instantiates ref for direct-init and brace-init', () => {
        expect(instNames('Calculator calc(0);')).toEqual(['Calculator']);
        expect(instNames('Widget w{1, 2};')).toEqual(['Widget']);
      });

      it('strips template args and namespace to the bare class name', () => {
        // `std::vector<int> v(10)` → `vector`; `ns::Widget w(0)` → `Widget`.
        expect(instNames('std::vector<int> v(10);')).toEqual(['vector']);
        expect(instNames('ns::Widget w(0);')).toEqual(['Widget']);
      });

      it('does not emit for primitives, default construction, or the most-vexing parse', () => {
        expect(instNames('int x(5);')).toEqual([]); // primitive direct-init
        expect(instNames('int y{6};')).toEqual([]); // primitive brace-init
        expect(instNames('auto z = make();')).toEqual([]); // auto + call (handled elsewhere)
        expect(instNames('Calculator deferred;')).toEqual([]); // default construction, no args
        expect(instNames('Calculator calc();')).toEqual([]); // function declaration (most-vexing parse)
      });

      it('emits a single instantiates ref for a multi-declarator statement', () => {
        // `Calculator a(1), b(2);` shares one `type` field; both construct a
        // Calculator, so one ref suffices (it dedups to one edge regardless).
        expect(instNames('Calculator a(1), b(2);')).toEqual(['Calculator']);
      });
    });

    describe('C/C++ imports', () => {
      it('should extract system include', () => {
        const code = `#include <iostream>`;
        const result = extractFromSource('main.cpp', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('iostream');
        expect(importNode?.signature).toBe('#include <iostream>');
      });

      it('should extract system include with path', () => {
        const code = `#include <nlohmann/json.hpp>`;
        const result = extractFromSource('app.cpp', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('nlohmann/json.hpp');
      });

      it('should extract local include', () => {
        const code = `#include "myheader.h"`;
        const result = extractFromSource('main.cpp', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('myheader.h');
      });

      it('should extract C header', () => {
        const code = `#include <stdio.h>`;
        const result = extractFromSource('main.c', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('stdio.h');
      });

      it('should extract multiple includes', () => {
        const code = `
#include <iostream>
#include <vector>
#include "config.h"
`;
        const result = extractFromSource('app.cpp', code);

        const importNodes = result.nodes.filter((n) => n.kind === 'import');
        expect(importNodes.length).toBe(3);

        const names = importNodes.map((n) => n.name);
        expect(names).toContain('iostream');
        expect(names).toContain('vector');
        expect(names).toContain('config.h');
      });

      it('should create unresolved references for local includes', () => {
        const code = `#include "myheader.h"`;
        const result = extractFromSource('main.cpp', code);

        const importRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'imports' && r.referenceName === 'myheader.h'
        );
        expect(importRef).toBeDefined();
        expect(importRef?.line).toBe(1);
      });

      it('should create unresolved references for system includes', () => {
        const code = `#include <iostream>`;
        const result = extractFromSource('main.cpp', code);

        const importRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'imports' && r.referenceName === 'iostream'
        );
        expect(importRef).toBeDefined();
      });
    });

    describe('Dart imports', () => {
      it('should extract dart: import', () => {
        const code = `import 'dart:async';`;
        const result = extractFromSource('main.dart', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('dart:async');
        expect(importNode?.signature).toBe("import 'dart:async';");
      });

      it('should extract package import', () => {
        const code = `import 'package:flutter/material.dart';`;
        const result = extractFromSource('app.dart', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('package:flutter/material.dart');
      });

      it('should extract aliased import', () => {
        const code = `import 'package:http/http.dart' as http;`;
        const result = extractFromSource('api.dart', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('package:http/http.dart');
        expect(importNode?.signature).toContain('as http');
      });

      it('should extract multiple imports', () => {
        const code = `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
`;
        const result = extractFromSource('main.dart', code);

        const importNodes = result.nodes.filter((n) => n.kind === 'import');
        expect(importNodes.length).toBe(3);

        const names = importNodes.map((n) => n.name);
        expect(names).toContain('dart:async');
        expect(names).toContain('dart:convert');
        expect(names).toContain('package:flutter/material.dart');
      });

      it('should extract relative import', () => {
        const code = `import '../utils/helpers.dart';`;
        const result = extractFromSource('lib/main.dart', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('../utils/helpers.dart');
      });
    });

    describe('Liquid imports', () => {
      it('should extract render tag', () => {
        const code = `{% render 'loading-spinner' %}`;
        const result = extractFromSource('template.liquid', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('loading-spinner');
        expect(importNode?.signature).toContain('render');
      });

      it('should extract section tag', () => {
        const code = `{% section 'header' %}`;
        const result = extractFromSource('layout/theme.liquid', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('header');
        expect(importNode?.signature).toContain('section');
      });

      it('should extract include tag', () => {
        const code = `{% include 'icon-cart' %}`;
        const result = extractFromSource('snippets/header.liquid', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('icon-cart');
        expect(importNode?.signature).toContain('include');
      });

      it('should extract render with whitespace control', () => {
        const code = `{%- render 'price' -%}`;
        const result = extractFromSource('snippets/product.liquid', code);

        const importNode = result.nodes.find((n) => n.kind === 'import');
        expect(importNode).toBeDefined();
        expect(importNode?.name).toBe('price');
      });

      it('should extract multiple imports', () => {
        const code = `
{% section 'header' %}
{% render 'loading-spinner' %}
{% render 'cart-drawer' %}
`;
        const result = extractFromSource('layout/theme.liquid', code);

        const importNodes = result.nodes.filter((n) => n.kind === 'import');
        expect(importNodes.length).toBe(3);

        const names = importNodes.map((n) => n.name);
        expect(names).toContain('header');
        expect(names).toContain('loading-spinner');
        expect(names).toContain('cart-drawer');
      });
    });
  });
}
