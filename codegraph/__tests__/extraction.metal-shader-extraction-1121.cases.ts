import { describe, expect, it } from 'bun:test';
import { extractFromSource } from '../src/extraction';
import { blankCppAnnotationMacroCalls, blankCppApiPrefixMacros, blankCppInlineAnnotationMacros, blankMetalAttributes } from '../src/extraction/languages/c-cpp';

export function registerMetalShaderExtraction1121Tests(): void {


  describe('Metal shader extraction (#1121)', () => {
    // Metal Shading Language (≈ C++14) parses with the C++ grammar. MSL puts
    // `[[attribute]]` annotations AFTER the declarator — a position
    // tree-sitter-cpp misparses: a struct field with a trailing attribute
    // emitted a spurious `extends` ref from the struct to the field's own type.
    // blankMetalAttributes (preParse, `.metal`-gated) blanks them so extraction
    // matches plain C++.
    const METAL = `#include <metal_stdlib>
using namespace metal;

struct VertexIn {
    float3 position [[attribute(0)]];
    float2 texCoord [[attribute(1)]];
};

struct VertexOut {
    float4 position [[position]];
    float2 texCoord;
};

struct Uniforms {
    float4x4 modelViewProjection;
};

static float4 applyGamma(float4 color) {
    return pow(color, float4(1.0 / 2.2));
}

vertex VertexOut vertexShader(VertexIn in [[stage_in]],
                              constant Uniforms &uniforms [[buffer(0)]]) {
    VertexOut out;
    out.position = uniforms.modelViewProjection * float4(in.position, 1.0);
    out.texCoord = in.texCoord;
    return out;
}

fragment float4 fragmentShader(VertexOut in [[stage_in]],
                               texture2d<float> colorTexture [[texture(0)]],
                               sampler textureSampler [[sampler(0)]]) {
    float4 color = colorTexture.sample(textureSampler, in.texCoord);
    return applyGamma(color);
}

kernel void computeBlur(texture2d<float, access::read> inTexture [[texture(0)]],
                        texture2d<float, access::write> outTexture [[texture(1)]],
                        uint2 gid [[thread_position_in_grid]]) {
    float4 color = inTexture.read(gid);
    outTexture.write(color, gid);
}
`;

    it('extracts vertex/fragment/kernel functions, structs, and calls from a .metal file', () => {
      const result = extractFromSource('Shaders.metal', METAL);
      expect(result.errors).toHaveLength(0);

      const functions = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(functions).toEqual(
        expect.arrayContaining(['applyGamma', 'vertexShader', 'fragmentShader', 'computeBlur'])
      );
      const structs = result.nodes.filter((n) => n.kind === 'struct').map((n) => n.name);
      expect(structs).toEqual(expect.arrayContaining(['VertexIn', 'VertexOut', 'Uniforms']));
      expect(result.nodes.find((n) => n.kind === 'import')?.name).toBe('metal_stdlib');

      // Attribute blanking is offset-preserving, so positions stay exact.
      const vertexFn = result.nodes.find((n) => n.name === 'vertexShader')!;
      expect(vertexFn.startLine).toBe(22);

      // The shader call graph connects: fragmentShader → applyGamma.
      expect(
        result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'applyGamma'
        )
      ).toBeTruthy();

      // The regression the blanking fixes: field attributes (`float3 position
      // [[attribute(0)]];`) misparsed into `extends` refs from the struct to the
      // field's type — a wrong inheritance edge whenever the repo defines that
      // type itself (simd typedefs in a shared ShaderTypes.h are common).
      expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'extends')).toHaveLength(0);
    });

    it('blankMetalAttributes blanks every attribute form, offset-preserving', () => {
      const inp = [
        'float4 position [[position]];',
        'constant Uniforms &u [[buffer(0)]]',
        'float2 uv [[user(locn0)]];',
        'device float *out [[buffer(0), raster_order_group(0)]]',
      ].join('\n');
      const out = blankMetalAttributes(inp);
      expect(out.length).toBe(inp.length); // every byte offset preserved
      expect(out).not.toContain('[[');
      // Nothing but the attributes changed: collapsing the blank runs gives the
      // plain declarations back, newlines untouched.
      expect(out.split('\n').map((l) => l.replace(/ +/g, ' ').trimEnd())).toEqual([
        'float4 position ;',
        'constant Uniforms &u',
        'float2 uv ;',
        'device float *out',
      ]);
    });

    it('blankMetalAttributes never touches non-attribute [[ sequences', () => {
      for (const c of [
        'auto x = arr[[]{ return 0; }()];', // lambda in subscript — the only other [[ in C++-family code
        'int y = a[b[i]];', // nested subscript
        'int z = 1;', // no [[ at all — early-return path
      ]) {
        expect(blankMetalAttributes(c)).toBe(c);
      }
    });
  });


  describe('C++ in-body reflection-macro annotations do not collapse the class (UE)', () => {
    // Unreal reflection markup — `UPROPERTY(...)`, `UFUNCTION(...)`,
    // `GENERATED_BODY()`, `UE_DEPRECATED_*(...)`, `DECLARE_DELEGATE_*(...)` — are
    // no-semicolon macro CALLS decorating members. tree-sitter doesn't know they
    // are macros, so each drops into error recovery; in a heavily-reflected class
    // the errors accumulate until the enclosing class_specifier can't close and
    // the whole class (its base clause and members) collapses into an ERROR node
    // and disappears from the graph. blankCppAnnotationMacroCalls strips them,
    // offset-preserving, so the class parses normally.
    it('recovers a heavily-reflected class with multiple inheritance + members', () => {
      const code = `UCLASS(MinimalAPI)
class UMyMovement : public UPawnMovementComponent, public IRVOAvoidanceInterface, public INetworkPredictionInterface
{
\tGENERATED_BODY()
public:
\tUE_DEPRECATED_FORGAME(5.0, "Deprecated; note the commas, and (parens) inside the string")
\tUPROPERTY(Category="Move", EditAnywhere, BlueprintReadWrite, meta=(ClampMin="0", UIMin="0"))
\tfloat MaxWalkSpeed;

\tUFUNCTION(BlueprintCallable, Category="Move")
\tfloat ComputeSpeed() const { return MaxWalkSpeed * 2.0f; }
};
`;
      const result = extractFromSource('movement.cpp', code);
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'UMyMovement');
      expect(cls).toBeTruthy();
      // The class body parses, so its inline method definition is extracted too —
      // proof the class_specifier closed instead of collapsing into an ERROR node.
      expect(result.nodes.some((n) => n.name === 'ComputeSpeed')).toBe(true);
      // The base clause survives (inheritance queries keep working).
      expect(
        result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'UPawnMovementComponent'
        )
      ).toBeTruthy();
    });

    it('strips line-leading no-semicolon ALL-CAPS calls, offset-preserving', () => {
      const inp = `\tUPROPERTY(EditAnywhere, meta=(ClampMin="0"))\n\tfloat X;\n`;
      const out = blankCppAnnotationMacroCalls(inp);
      expect(out.length).toBe(inp.length); // every byte offset preserved
      expect(out).not.toContain('UPROPERTY');
      expect(out).toContain('float X;');
      // A macro whose args carry commas/parens inside a string still balances.
      const inp2 = `UE_DEPRECATED_FORGAME(5.0, "a, b (c)")\nUPROPERTY(Foo)\nfloat Y;\n`;
      const out2 = blankCppAnnotationMacroCalls(inp2);
      expect(out2.length).toBe(inp2.length);
      expect(out2).not.toContain('UE_DEPRECATED_FORGAME');
      expect(out2).not.toContain('UPROPERTY');
      expect(out2).toContain('float Y;');
    });

    it('does NOT blank expression / condition / statement / init-list macro uses', () => {
      for (const c of [
        'void f() {\n\tif (CHECK_FLAG(x)) { g(); }\n}',   // condition — not line-leading
        'void f() {\n\tLOG_MESSAGE("hi");\n}',             // statement call — trailing ;
        'C::C()\n\t: MEMBER_A(1)\n\t, MEMBER_B(2)\n{}',    // init-list — comma / not line-leading
        'C::C() :\n\tMEMBER_A(1),\n\tMEMBER_B(2)\n{}',     // init-list wrapped — trailing , / {
        'auto y =\n\tMAKE_THING(a) + 1;',                  // line-leading but an expression fragment
      ]) {
        expect(blankCppAnnotationMacroCalls(c)).toBe(c);
      }
    });
  });


  describe('C++ member/method-level export macros do not orphan declarations (UE)', () => {
    // The `*_API` visibility macro doesn't only prefix the class header — it
    // prefixes almost every exported member/method of a big UE class
    // (`ENGINE_API virtual void Tick(…)`, `static ENGINE_API void Foo(…)`).
    // blankCppExportMacros only recovers the class-HEADER form; without blanking
    // the member form, tree-sitter reads `MACRO <ret> <name>(` as an extra type
    // token and each declaration drops into error recovery.
    it('recovers a class + base + members when members are *_API-prefixed', () => {
      const code = `class ENGINE_API AActor : public UObject
{
\tGENERATED_BODY()
public:
\tENGINE_API virtual void Tick(float DeltaSeconds);
\tstatic ENGINE_API void AddReferencedObjects(int32 Count);
\tENGINE_API float GetLifeSpan() const { return LifeSpan; }
};
`;
      const result = extractFromSource('actor.cpp', code);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'AActor')).toBe(true);
      // The inline definition (its body prefixed by ENGINE_API) is extracted —
      // proof the class_specifier closed instead of collapsing into an ERROR.
      expect(result.nodes.some((n) => n.name === 'GetLifeSpan')).toBe(true);
      // The base clause survives (inheritance queries keep working).
      expect(
        result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'UObject'
        )
      ).toBeTruthy();
    });

    it('blanks only the suffix macro before a declaration, offset-preserving', () => {
      const inp = `ENGINE_API void Tick();\nstatic MYMOD_EXPORT int32 X;\nLLVM_ABI bool Y();\n`;
      const out = blankCppApiPrefixMacros(inp);
      expect(out.length).toBe(inp.length); // every byte offset preserved
      expect(out).not.toContain('ENGINE_API');
      expect(out).not.toContain('MYMOD_EXPORT');
      expect(out).not.toContain('LLVM_ABI');
      expect(out).toContain('void Tick();');
      expect(out).toContain('int32 X;');
      expect(out).toContain('bool Y();');
      expect(out).toMatch(/static\s+int32 X;/); // `static` kept, only the macro blanked
    });

    it('does NOT blank an *_API token used as a value or in non-declaration position', () => {
      for (const c of [
        'int x = SOME_API;',              // rvalue — trailing ;
        'if (mode == FOO_API) { g(); }',  // comparison — trailing )
        'return DEFAULT_API, other;',     // comma operand
        'auto v = NS_API::Make();',       // qualified name — trailing ::
        'x = A_API + B_API;',             // operands of + / trailing ;
      ]) {
        expect(blankCppApiPrefixMacros(c)).toBe(c);
      }
    });

    it('leaves a genuine _API-suffixed word alone when it is itself the name', () => {
      // A longer word merely CONTAINING _API (not ending in it) must not match.
      const inp = 'FOO_APIENTRY handler;';
      expect(blankCppApiPrefixMacros(inp)).toBe(inp);
    });
  });


  describe('C++ mid-line UE annotation macros do not collapse the enum/class (UE)', () => {
    // UMETA / UPARAM / UE_DEPRECATED can sit MID-LINE (not line-leading), where
    // blankCppAnnotationMacroCalls structurally can't reach them: an enum value's
    // `UMETA(...)`, or a deprecation tag wedged into a class-scope `using`
    // (`using X UE_DEPRECATED(5.5, "…") = …;`) — which alone collapsed UWorld in
    // World.h. blankCppInlineAnnotationMacros strips them, offset-preserving.
    it('recovers a class whose in-body using-alias carries a mid-line UE_DEPRECATED', () => {
      const code = `class ENGINE_API UWorld : public UObject
{
\tGENERATED_BODY()
public:
\tusing FOnNetTickEvent UE_DEPRECATED(5.5, "use TMulticastDelegate<void(float)>") = TMulticastDelegate<void(float)>;
\tENGINE_API float GetTimeSeconds() const { return TimeSeconds; }
};
`;
      const result = extractFromSource('world.cpp', code);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'UWorld')).toBe(true);
      // The member after the poison using-alias is reached — the class closed.
      expect(result.nodes.some((n) => n.name === 'GetTimeSeconds')).toBe(true);
      expect(
        result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'UObject'
        )
      ).toBeTruthy();
    });

    it('blanks mid-line UMETA/UPARAM/UE_DEPRECATED with balanced parens, offset-preserving', () => {
      const inp = `enum class EMode : uint8 {\n\tWalk UMETA(DisplayName="Walk (fast), safe"),\n\tRun\n};\n`;
      const out = blankCppInlineAnnotationMacros(inp);
      expect(out.length).toBe(inp.length);
      expect(out).not.toContain('UMETA');
      expect(out).toContain('Walk');
      expect(out).toContain('Run');
      const inp2 = `void F(UPARAM(ref) int& x) {}\n`;
      const out2 = blankCppInlineAnnotationMacros(inp2);
      expect(out2.length).toBe(inp2.length);
      expect(out2).not.toContain('UPARAM');
      expect(out2).toContain('int& x');
    });

    it('does NOT touch source without those UE-only macro names', () => {
      const c = 'enum class E { A, B };\nvoid metadata(int meta) { return; }\n';
      expect(blankCppInlineAnnotationMacros(c)).toBe(c);
    });
  });


  describe('C++ dense Unreal-Engine header regression (#1160/#1158)', () => {
    // Regression guard for the three UE blank passes together, on a HEAVILY
    // reflected class in the shape that broke real engine headers
    // (`CharacterMovementComponent.h` carries ~240 in-body reflection macros).
    // On the real headers the accumulated tree-sitter errors collapse the whole
    // `class_specifier` into an ERROR node and the class itself vanishes; that
    // full collapse is emergent from real-header content we can't ship here
    // (Unreal's source is EULA-licensed), so this reproduces the *recoverable*
    // signal it leaves: with the blank passes reverted, tree-sitter drops every
    // one of these decorated members and the `UMETA` enum into error recovery,
    // so the assertions below flip from pass to fail. Verified against the
    // pre-fix build: `Compute0`, the last member, and `EDenseMode` are all
    // absent before the fix and present after — reverting any of
    // blankCppAnnotationMacroCalls / blankCppApiPrefixMacros /
    // blankCppInlineAnnotationMacros regresses at least one of them.
    const N = 120; // 120 UPROPERTY + 120 UFUNCTION = ~240 in-body macros
    function denseReflectedHeader(): string {
      let members = '';
      for (let i = 0; i < N; i++) {
        // line-leading UPROPERTY with nested meta=(...) (blankCppAnnotationMacroCalls)
        members += `\tUPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Move", meta=(ClampMin="0.0", EditCondition="bOn${i}", AllowedClasses="/Script/Engine.Texture"))\n\tTSubclassOf<AActor> Prop${i};\n`;
        // line-leading UFUNCTION + member-level ENGINE_API + UPARAM(ref) param
        // (all three passes) on an inline definition (has a body → is a node)
        members += `\tUFUNCTION(BlueprintCallable, Category="Move", meta=(DisplayName="Compute ${i}"))\n\tENGINE_API float Compute${i}(UPARAM(ref) float& In) const { return In * ${i}.0f; }\n`;
      }
      return `UCLASS(MinimalAPI, Blueprintable)
class ENGINE_API UDenseMovement : public UPawnMovementComponent, public IRVOAvoidanceInterface, public INetworkPredictionInterface
{
\tGENERATED_BODY()
public:
\tDECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnMoved, float, Speed, FVector, Loc);
\tusing FLegacyTick UE_DEPRECATED(5.5, "use TDelegate<void(float)>") = TMulticastDelegate<void(float)>;
${members}};

UENUM(BlueprintType)
enum class EDenseMode : uint8
{
\tWalking UMETA(DisplayName="Walk (fast), safe"),
\tFlying  UMETA(DisplayName="Fly"),
\tCustom  UMETA(Hidden),
};
`;
    }

    it('recovers a ~240-macro reflected class, its base clause, and every decorated member', () => {
      const result = extractFromSource('DenseMovement.h', denseReflectedHeader());
      // The class and its whole multiple-inheritance base clause survive.
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'UDenseMovement')).toBe(true);
      for (const base of ['UPawnMovementComponent', 'IRVOAvoidanceInterface', 'INetworkPredictionInterface']) {
        expect(
          result.unresolvedReferences.find((r) => r.referenceKind === 'extends' && r.referenceName === base)
        ).toBeTruthy();
      }
      // The real guard: the decorated inline members parse instead of being lost
      // to error recovery — the first, a middle, and the LAST (proof the whole
      // dense body closed, not just the head).
      expect(result.nodes.some((n) => n.name === 'Compute0')).toBe(true);
      expect(result.nodes.some((n) => n.name === 'Compute60')).toBe(true);
      expect(result.nodes.some((n) => n.name === `Compute${N - 1}`)).toBe(true);
    });

    it('recovers a UENUM whose values carry mid-line UMETA', () => {
      const result = extractFromSource('DenseMovement.h', denseReflectedHeader());
      // A mid-line UMETA drops the enum into error recovery pre-fix;
      // blankCppInlineAnnotationMacros restores it.
      expect(result.nodes.some((n) => n.kind === 'enum' && n.name === 'EDenseMode')).toBe(true);
    });
  });

}
