# Atom Material file icons

The Explorer uses the SVG assets and filename associations from
[Atom Material Icons for JetBrains](https://github.com/AtomMaterialUI/a-file-icon-idea),
not the `file-icons/atom` icon fonts.

## Provenance

- Plugin commit: `0f0a41f20856c83da505bee9da0e12e4ac5bfac1`.
- Its `iconGenerator` submodule: [AtomMaterialUI/iconGenerator](https://github.com/AtomMaterialUI/iconGenerator),
  commit `3efb7279176465d18e048d6eed8b916e9c7acd89`.
- `fileIconRules.json` is generated from that submodule's `icon_associations.xml`.
  Use XML, as the upstream JSON export has older associations.
- `assets/` contains only SVGs referenced by those file rules. For Cheshi's dark
  workspace, use the corresponding `_dark.svg` when provided, saved under the
  rule's original basename. Preserve SVG contents and license notices. Where upstream omits `viewBox`,
  add `0 0 width height` using its intrinsic dimensions so resizing preserves
  the complete icon.
- License: [MIT](../../../../../../LICENSES/atom-material-icons.LICENSE).

## Import and matching

Read all `regex` entries in XML order, sort by descending numeric `priority`
with stable ties, retain only the first occurrence of each identical pattern,
and emit `[pattern, iconBasename]` pairs into the generated JSON. Later identical
patterns can never win a match, even when they reference a different icon.
Copy their SVGs from `assets/icons/files/`, choosing dark variants as above.
Keep only assets referenced by the retained rules.
All filename associations are enabled, including optional upstream icon packs;
JetBrains-specific file-type and PSI rules are not used.

The resolver preserves upstream case-insensitive full-string matching and uses
normalized file paths for patterns containing `/`. It bounds its result cache.
Cheshi maps `.mts`, `.cts`, and `.jts` to the TypeScript icon before upstream
filename rules, including tool configuration files such as `forge.config.mts`.
Unmatched files retain the Lucide fallback. Folder and disclosure icons remain
separate from this file-icon set.

The renderer uses an SVG image inside the shared `--icon-size-default` square,
with centered `object-fit: contain`; no glyph offsets or font baselines apply.
Vite emits the SVGs as local assets using `?no-inline`, without runtime network
requests or font dependencies. Original icon colors remain independent of Git
status colors on filenames.

After updating, run `bun test desktop/test/file-icon-resolver.test.ts`, the
workspace Git status suite, `bun run viewer:typecheck`, and `bun run viewer:build`.
