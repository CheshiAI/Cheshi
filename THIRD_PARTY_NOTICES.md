# Third-party notices

Cheshi's original code is licensed under the root [MIT License](LICENSE).
That license does not replace the licenses of included third-party material.
Keep the original copyright notices and applicable license terms with copies
and redistributions of that material.

## Included source

| Component | Included material | License and attribution |
| --- | --- | --- |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | CodeGraph engine and related source under `codegraph/` | [MIT, Colby Mchenry](codegraph/LICENSE) |
| electron-libghostty | Native terminal integration derived from electron-libghostty | [MIT notice](desktop/native/electron-libghostty/LICENSE.electron-libghostty) |
| libghostty-spm | Swift integration for libghostty | [MIT notice](desktop/native/ghostty-bridge/LICENSE.libghostty-spm) |
| MSDisplayLink | Display-link integration used by the terminal bridge | [MIT notice](desktop/native/ghostty-bridge/LICENSE.msdisplaylink) |

CodeGraph contains modifications for Cheshi. Its original MIT notice remains
in place. Native bridge dependency revisions and repository addresses are
recorded in [Package.swift](desktop/native/ghostty-bridge/Package.swift) and
[Package.resolved](desktop/native/ghostty-bridge/Package.resolved).

## Vendored Tree-sitter grammars

Generated parser code and scanner sources are included intentionally: they are
inputs to the native CodeGraph kernel. They are not local build leftovers.

| Grammar | Source notice |
| --- | --- |
| Dart | [MIT](codegraph/codegraph-kernel/grammars/dart/LICENSE) |
| Kotlin | [MIT](codegraph/codegraph-kernel/grammars/kotlin/LICENSE) |
| Lua | [MIT](codegraph/codegraph-kernel/grammars/lua/LICENSE) |
| Scala | [MIT](codegraph/codegraph-kernel/grammars/scala/LICENSE) |
| Tree-sitter headers | [MIT](LICENSES/tree-sitter.LICENSE) |

The WebAssembly files in `codegraph/src/extraction/wasm/` are also intentional
runtime inputs. Upstream license texts are preserved in [LICENSES/](LICENSES/).
[The source inventory](LICENSES/SOURCES.json) maps each file to its upstream,
license source, local checksum, and the limits of the available provenance.

- TypeScript and TSX share the TypeScript grammar license.
- CFML, CFScript, and CFQuery share the CFML grammar license.
- The HCL grammar used for Terraform and the Erlang grammar use Apache-2.0.
  Other collected grammar notices use MIT.
- A version mentioned in source comments is not by itself proof that a binary
  was built from that exact version. The inventory distinguishes recorded
  versions from byte comparisons and unresolved origins.

## Provenance and verification limits

The inventory covers all 29 inherited WASM files. The CFML family, Pascal,
COBOL, VB.NET, and Erlang binaries were compared byte-for-byte with artifacts
at immutable commits in the original CodeGraph repository. ArkTS was compared
with the published npm package. Other grammar revisions are documented in
source comments; the inventory does not claim a fresh source rebuild.

The original COBOL and VB.NET build documents and patches have been restored
under [LICENSES/provenance/](LICENSES/provenance/). The source inventory records
their upstream URLs and checksums, as well as the Pascal dependency pin and
Erlang release tag recovered from the original project history.

The remaining source-rebuild limitation is the CFML family: the upstream
CodeGraph record identifies `master` near `v0.26.29` and Tree-sitter CLI `0.26.9`,
but does not record the exact grammar commit. Its three artifacts are identified
by immutable CodeGraph source URLs and checksums; the license is preserved from
`v0.26.29`. Record an exact grammar commit when regenerating those artifacts.
Individual generated Tree-sitter header revisions were not independently traced.

## Installed dependencies and packaged applications

Bun, Cargo, and Swift dependencies keep their own licenses. See the package
manifests, lockfiles, and notices included with their distributions.
`node_modules/`, native build outputs, and packaged applications are excluded
from this source repository.

Before distributing an application build, include the notices required by all
material it actually bundles, including Electron, Ghostty itself, its native
dependencies, the renderer dependencies, language servers, and grammar runtimes.
The libghostty-spm wrapper's MIT license is not a substitute for Ghostty's own
license and bundled dependency notices.
