import { describe, expect, it } from 'bun:test';
import { extractFromSource } from '../src/extraction';
import { blankCudaConstructs } from '../src/extraction/languages/c-cpp';

export function registerCudaExtraction387Tests(): void {


  describe('CUDA extraction (#387)', () => {
    // CUDA parses with the C++ grammar. Three CUDA-only shapes misparse:
    // execution-space specifiers (`__global__ void f(…)`) shunt the real return
    // type into an ERROR node, `__shared__ float tile[256]` mangles the declared
    // name to `float`, and — the critical one — `k<<<grid, block>>>(args)` lexes
    // as shift operators around an empty-named template so NO call_expression
    // (and therefore no host→kernel call edge) exists. blankCudaConstructs
    // (preParse, `.cu`/`.cuh`-gated) blanks all three so extraction matches
    // plain C++.
    const CUDA = `#include <cuda_runtime.h>
#include "kernels.cuh"

__constant__ float d_scale[16];

__device__ __forceinline__ float warp_reduce_sum(float val) {
    for (int offset = 16; offset > 0; offset /= 2) {
        val += __shfl_down_sync(0xffffffff, val, offset);
    }
    return val;
}

__global__ void scale_kernel(float* out, const float* __restrict__ in, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    __shared__ float tile[256];
    if (i < n) {
        tile[threadIdx.x] = in[i];
        __syncthreads();
        out[i] = warp_reduce_sum(tile[threadIdx.x]) * d_scale[0];
    }
}

__global__ void __launch_bounds__(256, 4) bounded_kernel(float* data, int n) {
    if (blockIdx.x * blockDim.x + threadIdx.x < n) data[0] *= 2.0f;
}

template <typename T, int BLOCK>
__global__ void templated_kernel(T* data, int n) {
    if (blockIdx.x * BLOCK + threadIdx.x < n) data[0] += T(1);
}

class GpuBuffer {
public:
    explicit GpuBuffer(size_t n) { cudaMalloc(&ptr_, n * sizeof(float)); }
    ~GpuBuffer() { cudaFree(ptr_); }
private:
    float* ptr_ = nullptr;
};

void launch_scale(float* out, const float* in, int n, cudaStream_t stream) {
    dim3 block(256);
    dim3 grid((n + block.x - 1) / block.x);
    scale_kernel<<<grid, block, 0, stream>>>(out, in, n);
    bounded_kernel<<<grid,
                     block>>>(out, n);
    templated_kernel<float, 256><<<grid, block>>>(out, n);
}
`;

    it('extracts kernels, device functions, and host→kernel launch calls from a .cu file', () => {
      const result = extractFromSource('kernels/scan.cu', CUDA);
      expect(result.errors).toHaveLength(0);

      const functions = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(functions).toEqual(
        expect.arrayContaining([
          'warp_reduce_sum',
          'scale_kernel',
          'bounded_kernel',
          'templated_kernel',
          'launch_scale',
        ])
      );
      expect(result.nodes.filter((n) => n.kind === 'class').map((n) => n.name)).toContain('GpuBuffer');
      expect(result.nodes.find((n) => n.kind === 'import')?.name).toBe('cuda_runtime.h');

      // No misparse artifacts: pre-blank, `__shared__ float tile[256]` parsed
      // with `float` as the declared name. (Top-level C++ variables aren't
      // extracted as nodes — matching plain-C++ behavior is the target.)
      expect(result.nodes.map((n) => n.name)).not.toContain('float');

      // Blanking is offset-preserving, so positions stay exact.
      expect(result.nodes.find((n) => n.name === 'scale_kernel')!.startLine).toBe(13);

      // THE point of CUDA support: every `<<<…>>>` launch form — plain,
      // launch-bounds, multi-line config, and templated — emits a `calls`
      // reference, so the host→kernel edge exists in the graph. Pre-blank,
      // the chevrons lexed as shifts and none of these existed.
      const calls = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      // The templated launch is normalized to the bare kernel name (template
      // args stripped at extraction, like base-class extends refs — #1043), so
      // it resolves to the kernel the template was defined as.
      expect(calls).toEqual(
        expect.arrayContaining([
          'scale_kernel',
          'bounded_kernel',
          'templated_kernel',
          'warp_reduce_sum',
        ])
      );
    });

    it('blankCudaConstructs blanks every CUDA form, offset- and newline-preserving', () => {
      const inp = [
        '__global__ void __launch_bounds__(256, 4) step(float* p) {',
        '    __shared__ float tile[32];',
        '}',
        '__host__ __device__ int both() { return 0; }',
        'void run(float* p, int n) {',
        '    step<<<grid,',
        '           block, 0, stream>>>(p);',
        '}',
      ].join('\n');
      const out = blankCudaConstructs(inp);
      expect(out.length).toBe(inp.length); // every byte offset preserved
      expect(out.split('\n').length).toBe(inp.split('\n').length); // newlines survive the multi-line launch config
      expect(out).not.toMatch(/__global__|__launch_bounds__|__shared__|__host__|__device__|<<<|>>>/);
      // Collapsing blank runs gives plain C++ back.
      expect(out.split('\n').map((l) => l.replace(/ +/g, ' ').trimEnd())).toEqual([
        ' void step(float* p) {',
        ' float tile[32];',
        '}',
        ' int both() { return 0; }',
        'void run(float* p, int n) {',
        ' step',
        ' (p);',
        '}',
      ]);
    });

    it('blankCudaConstructs never touches non-CUDA chevrons or identifiers', () => {
      for (const c of [
        'std::cout << "a" << b << c;', // shift chains — never three consecutive <
        'auto x = f(a >> 3, b >> 3);', // right shifts
        'std::vector<std::vector<std::vector<int>>> deep;', // template >>> closer with no <<< opener
        'printf("<<<unterminated");', // <<< in a string with no >>> anywhere
        'int __restrict__like = 1;', // dunder-ish identifier not in the specifier list
        'int z = 1;', // nothing CUDA at all — early-return path
      ]) {
        expect(blankCudaConstructs(c)).toBe(c);
      }
      // A stray `<<<` (committed merge-conflict marker) must not blank the code
      // between markers. Two independent guards: statements between markers
      // carry `;` (excluded from the span)…
      const conflict = [
        '<<<<<<< HEAD',
        'int a = compute(1);',
        '=======',
        'int a = compute(2);',
        '>>>>>>> feature-branch',
      ].join('\n');
      expect(blankCudaConstructs(conflict)).toBe(conflict);
      // …and a `;`-free region still fails the brace-balance check (the `{`s
      // opened between the markers never close before the `>>>`).
      const semicolonFree = [
        '<<<<<<< HEAD',
        'void foo() {',
        '=======',
        'void bar() {',
        '>>>>>>> feature-branch',
      ].join('\n');
      expect(blankCudaConstructs(semicolonFree)).toBe(semicolonFree);
    });

    it('blanks brace-initialized launch configs (`dim3{…}`), balanced-only', () => {
      const inp = 'run_it<<<dim3{1, 2, 1}, dim3{256, 1, 1}, 0, stream>>>(data, n);';
      const out = blankCudaConstructs(inp);
      expect(out.length).toBe(inp.length);
      expect(out.replace(/ +/g, ' ')).toBe('run_it (data, n);');
    });

    it('recovers the real kernel name from a macro-definition idiom, gtest/pybind untouched', () => {
      const code = `#define DEFINE_MY_FWD_KERNEL(kernelName, ...) \\
template<typename Traits, __VA_ARGS__> \\
__global__ void kernelName(const Params params)

DEFINE_MY_FWD_KERNEL(fwd_kernel, bool Is_causal, int kBlockM) {
    do_work(params);
}

TEST_F(MyFixture, HandlesEmptyInput) {
    check(1);
}
`;
      const result = extractFromSource('kernels/impl.cu', code);
      const functions = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      // The macro invocation's first argument is the defined name.
      expect(functions).toContain('fwd_kernel');
      expect(functions).not.toContain('DEFINE_MY_FWD_KERNEL');
      // gtest's TEST_F(Fixture, Name) has TWO lone identifiers — ambiguous, so
      // it keeps the macro name rather than guessing.
      expect(functions).toContain('TEST_F');
      expect(functions).not.toContain('MyFixture');
    });

    it('links launches through a local function pointer to the real kernel(s)', () => {
      // The flash-attention launch-template shape end-to-end: a macro-defined
      // kernel + `auto kernel = &fn<…>` + branch reassignment + launch through
      // the local. The call refs must name the real kernels, not `kernel`.
      const code = `template <typename T, bool Flag>
__global__ void fwd_kernel(T* data, int n) {
    if (blockIdx.x * blockDim.x + threadIdx.x < n) data[0] += T(1);
}

template <typename T>
__global__ void fwd_splitkv_kernel(T* data, int n) {
    if (blockIdx.x * blockDim.x + threadIdx.x < n) data[0] += T(2);
}

template <typename T>
void run_fwd(T* data, int n, cudaStream_t stream) {
    auto kernel = &fwd_kernel<T, true>;
    if (n % 2 == 0) {
        kernel = &fwd_kernel<T, false>;
    } else if (n % 3 == 0) {
        kernel = &fwd_splitkv_kernel<T>;
    }
    kernel<<<(n + 255) / 256, 256, 0, stream>>>(data, n);
}
`;
      const result = extractFromSource('kernels/launch.cu', code);
      expect(result.errors).toHaveLength(0);
      const calls = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      // Every DISTINCT branch target recorded once — the two fwd_kernel<…>
      // instantiations strip to one target, the splitkv branch adds a second.
      // The local's name never leaks as a callee.
      expect(calls.filter((c) => c === 'fwd_kernel')).toHaveLength(1);
      expect(calls.filter((c) => c === 'fwd_splitkv_kernel')).toHaveLength(1);
      expect(calls).not.toContain('kernel');
    });

    it('CUDA blanking is gated by extension or content — plain C++ shift/template chevrons are untouched', () => {
      const cpp = `#include <vector>
int shift_it(int a, int b) { return a << b << 1; }
std::vector<std::vector<std::vector<int>>> matrix() { return {}; }
`;
      const result = extractFromSource('math.cpp', cpp);
      expect(result.errors).toHaveLength(0);
      const functions = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(functions).toEqual(expect.arrayContaining(['shift_it', 'matrix']));
    });

    it('CUDA in extension-less headers is caught by content: launch templates in .h connect host→kernel', () => {
      // Much real CUDA lives in .h: cutlass launches most of its kernels from
      // headers, flash-attention's launch templates are .h, llm.c keeps device
      // helpers in C-detected .h. `looksLikeCudaSource` content-gates the same
      // blank there — no CUDA marker is valid C++ anywhere, so this can't
      // affect a genuinely-plain C++ header.
      const header = `#pragma once
#include <cuda_runtime.h>

template <typename T>
__global__ void fill_kernel(T* out, T value, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) out[i] = value;
}

template <typename T>
void launch_fill(T* out, T value, int n, cudaStream_t stream) {
    fill_kernel<T><<<(n + 255) / 256, 256, 0, stream>>>(out, value, n);
}
`;
      const result = extractFromSource('include/fill_launch_template.h', header);
      expect(result.errors).toHaveLength(0);
      const functions = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(functions).toEqual(expect.arrayContaining(['fill_kernel', 'launch_fill']));
      const calls = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(calls).toContain('fill_kernel');
    });
  });


  describe('C++ namespace qualifiedName prefixing', () => {
    // C++ namespaces previously left no trace in qualifiedNames, so a
    // namespace-qualified call (`flash::compute(...)`) could never match its
    // definition — every `ns::fn()` call site was a permanently dead edge.
    // The namespace name now prefixes contained symbols' qualifiedNames
    // (prefix-only: no namespace node is minted — `namespace cutlass {` opens
    // in thousands of files and a node per block would crowd search, #1093).
    it('prefixes contained symbols and handles nesting; anonymous stays bare', () => {
      const code = `namespace flash {
namespace detail {
void helper() {}
}
void compute_attn(int x) { detail::helper(); }
class Softmax {
public:
    void rescale() {}
};
}
namespace {
void file_local() {}
}
void global_fn() { flash::compute_attn(1); }
`;
      const result = extractFromSource('dispatch.cpp', code);
      expect(result.errors).toHaveLength(0);
      const byName = new Map(result.nodes.map((n) => [n.name, n]));
      expect(byName.get('compute_attn')?.qualifiedName).toBe('flash::compute_attn');
      expect(byName.get('helper')?.qualifiedName).toBe('flash::detail::helper');
      expect(byName.get('Softmax')?.qualifiedName).toBe('flash::Softmax');
      // Class scope still stacks under the namespace prefix.
      expect(byName.get('rescale')?.qualifiedName).toBe('flash::Softmax::rescale');
      // Anonymous namespace contents and true globals stay bare.
      expect(byName.get('file_local')?.qualifiedName).toBe('file_local');
      expect(byName.get('global_fn')?.qualifiedName).toBe('global_fn');
      // The qualified call refs are emitted as spelled.
      const calls = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(calls).toEqual(expect.arrayContaining(['flash::compute_attn', 'detail::helper']));
    });

    it('C++17 nested namespace form prefixes as written', () => {
      const code = `namespace a::b {
int f() { return 1; }
}
`;
      const result = extractFromSource('nested.cpp', code);
      expect(result.nodes.find((n) => n.name === 'f')?.qualifiedName).toBe('a::b::f');
    });

    // Out-of-line member definitions take their qualifiedName from the
    // declarator's receiver (`ManifestStartup::Apply`), which is spelled
    // RELATIVE to the enclosing namespace — the namespace prefix must compose
    // in, or the method's qualifiedName diverges from its own class node's
    // and `ns::Class::Method(...)` call sites never resolve (#1291).
    it('out-of-line method definitions inside a namespace carry the namespace prefix', () => {
      const code = `namespace simulator {
class ManifestStartup {
public:
    struct Input { int x; };
    struct Output { int y; };
    static Output Apply(const Input& input);
};
ManifestStartup::Output ManifestStartup::Apply(const Input& input) { return {}; }
}
`;
      const result = extractFromSource('manifest_startup.cpp', code);
      const apply = result.nodes.filter((n) => n.name === 'Apply');
      // The out-of-line definition's QN matches the class node's prefix.
      expect(apply.map((n) => n.qualifiedName)).toContain('simulator::ManifestStartup::Apply');
      expect(result.nodes.find((n) => n.kind === 'class')?.qualifiedName).toBe(
        'simulator::ManifestStartup'
      );
    });

    it('a receiver that re-spells the namespace path is not double-prefixed', () => {
      const code = `namespace sim {
class M { public: static void f(); static void g(); };
void sim::M::f() {}
void M::g() {}
}
void sim::M::f2() {}
`;
      const result = extractFromSource('m.cpp', code);
      const qns = result.nodes.filter((n) => n.kind === 'method').map((n) => n.qualifiedName);
      expect(qns).toContain('sim::M::f'); // fully re-spelled inside the namespace
      expect(qns).toContain('sim::M::g'); // relative form
      expect(qns).toContain('sim::M::f2'); // global scope, spelled absolute
      expect(qns.find((q) => q?.includes('sim::sim'))).toBeUndefined();
    });
  });


  describe('C++ forward declarations do not mint phantom class nodes (#1093)', () => {
    // `class Foo;` parses as a bodiless class_specifier. Repeated across headers,
    // each forward decl minted a phantom bodiless `class` node that crowded out —
    // and could be picked as the blast-radius representative over — the single
    // real definition. Bodiless struct/enum specifiers were already skipped;
    // classes now are too, but ONLY for C/C++ (opt-in flag), never for languages
    // where a bodiless class is a complete definition.
    it('keeps only the real definition, dropping repeated forward decls', () => {
      const code = `
class APXCharacter;   // forward decl (header 1)
class APXCharacter;   // forward decl (header 2)
friend class APXCharacter;   // elaborated / friend forward reference

class APXCharacter {  // the one real definition
  int hp;
  void takeDamage(int amount) { hp -= amount; }
};
`;
      const result = extractFromSource('character.cpp', code);
      const classes = result.nodes.filter(
        (n) => n.kind === 'class' && n.name === 'APXCharacter'
      );
      // Exactly one class node, and it's the definition (carries the member).
      expect(classes).toHaveLength(1);
      expect(classes[0].startLine).toBe(6);
      expect(
        result.nodes.some((n) => n.kind === 'method' && n.name === 'takeDamage')
      ).toBe(true);
    });

    it('elaborated type references in declarations create no phantom class', () => {
      // `class Foo obj;` is a variable declaration using an elaborated type, not
      // a class definition — it must not mint a `Foo` class node.
      const result = extractFromSource('use.cpp', 'class Foo;\nvoid f() { class Foo *p = nullptr; (void)p; }\n');
      expect(result.nodes.filter((n) => n.kind === 'class' && n.name === 'Foo')).toHaveLength(0);
    });

    it('does NOT affect languages where a bodiless class is complete', () => {
      // Kotlin `class Empty` and Scala `trait`/`case object`/`class` with no body
      // are complete definitions — the C/C++-only skip must leave them indexed.
      const kt = extractFromSource('Empty.kt', 'class Empty\nclass Full { val x = 1 }\n');
      const ktClasses = kt.nodes.filter((n) => n.kind === 'class').map((n) => n.name);
      expect(ktClasses).toContain('Empty');
      expect(ktClasses).toContain('Full');

      const scala = extractFromSource('M.scala', 'trait Marker\ncase object Red\nclass Foo\n');
      const scalaNames = scala.nodes
        .filter((n) => ['class', 'trait', 'interface'].includes(n.kind))
        .map((n) => n.name);
      expect(scalaNames).toEqual(expect.arrayContaining(['Marker', 'Red', 'Foo']));
    });
  });


  describe('C++ reference-return method/function names (#1093 follow-up)', () => {
    // An inline method/function returning a reference parses with a
    // `reference_declarator` wrapping the `function_declarator`. That wrapper
    // wasn't unwrapped (only `pointer_declarator` was), so the name captured the
    // whole declarator — `const int& getRef() const {…}` became the method named
    // "& getRef() const" instead of "getRef", polluting search and callers. Very
    // common in Unreal Engine headers (`const FGameplayTagContainer& GetActiveTags() const`).
    const namesOf = (code: string) =>
      extractFromSource('r.cpp', code).nodes
        .filter((n) => n.kind === 'method' || n.kind === 'function')
        .map((n) => n.name);

    it('names an inline reference-returning method by its identifier, not the declarator', () => {
      const names = namesOf('class C {\npublic:\n  const int& getRef() const { return x; }\n  int& mutRef() { return x; }\n  int x;\n};');
      expect(names).toContain('getRef');
      expect(names).toContain('mutRef');
      // No name leaks the reference sigil or the parameter/qualifier tail.
      expect(names.some((n) => /[&()]/.test(n))).toBe(false);
    });

    it('handles rvalue-reference returns and reference-returning free functions', () => {
      expect(namesOf('class C { int&& take() { return 1; } };')).toContain('take');
      expect(namesOf('const int& globalRef() { static int x; return x; }')).toContain('globalRef');
    });

    it('leaves pointer, value, and out-of-line reference returns unchanged (controls)', () => {
      expect(namesOf('class C { int* getPtr() { return &x; } int x; };')).toContain('getPtr');
      expect(namesOf('class C { int getVal() const { return x; } int x; };')).toContain('getVal');
      // Out-of-line `T& C::f()` already resolves via the qualified-name hook.
      expect(namesOf('const int& C::getRef() const { return x; }')).toContain('getRef');
    });
  });


  describe('C++ user-defined conversion operator names (#1093 follow-up)', () => {
    // A conversion operator's declarator is an `operator_cast` (target type +
    // `() const` tail). It was named with the whole declarator —
    // `operator EALSMovementState() const` — so it didn't match the symbolic-
    // overload style (`operator+`) and carried parameter noise. It's now named
    // `operator <type>`. Common in Unreal Engine enum-wrapper structs.
    const namesOf = (code: string) =>
      extractFromSource('o.cpp', code).nodes
        .filter((n) => n.kind === 'method' || n.kind === 'function')
        .map((n) => n.name);

    it('names a conversion operator as "operator <type>", not the full declarator', () => {
      const names = namesOf('struct S {\n  operator int() const { return 1; }\n  operator bool() { return true; }\n  int x;\n};');
      expect(names).toContain('operator int');
      expect(names).toContain('operator bool');
      expect(names.some((n) => n.includes('(') || n.includes('const'))).toBe(false);
    });

    it('handles a user-type conversion operator', () => {
      expect(
        namesOf('struct FALSMovementState {\n  operator EALSMovementState() const { return State; }\n  EALSMovementState State;\n};')
      ).toContain('operator EALSMovementState');
    });

    it('leaves symbolic operator overloads unchanged (control)', () => {
      const names = namesOf('struct S {\n  S operator+(const S& o) const { return o; }\n  int& operator[](int i) { return x; }\n  int x;\n};');
      expect(names).toContain('operator+');
      expect(names).toContain('operator[]'); // reference-returning subscript, name still clean
    });
  });

}
