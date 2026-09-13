# Desktop Instructions

These instructions apply to `desktop/` and its descendants, together with the
repository root instructions.

## Circular icon buttons

- Match the theme toggle for standard circular icon-only controls:
  **22px × 22px button, 11px × 11px SVG, stroke width 1.7**.
- Tab close and input clear X controls use the compact exception:
  **18px × 18px button, 9px × 9px SVG, stroke width 1.7**. Reuse
  `--compact-icon-button-size`, `--compact-icon-size`, and
  `--compact-icon-stroke-width` from `frontend/src/styles.css`.
- Use a circular shape through `--neumorphic-button-radius: 50%`, center the
  icon, and use zero padding. Enabled controls use a pointer cursor.
- Reuse `NeumorphicButton` with `raised` from `frontend/src/shared/ui` and its
  existing theme-aware background, hover, and pressed styles.
- Use the corresponding Lucide icon. The reference is the theme toggle in
  `frontend/src/features/chrome/ThemeToggle.tsx` and the `.theme-toggle` and
  `.theme-toggle-icon svg` rules in `frontend/src/styles.css`.
- These 11px and 9px sizes override the root's general 15px icon default for
  their respective circular controls. File icons, inline icons, and decorative artwork keep
  their applicable sizing rules.
- Apply this standard when adding or changing a circular icon button; update
  other existing controls only when they are within the requested scope.

## Shared input fields

- Use `NeumorphicTextField` from `frontend/src/shared/ui` for standard text
  and search inputs. The reference is the Plugins header search field; the
  editor's Find and Replace fields use the same component.
- Single-line fields use **34px height, 9px corner radius, 10px system UI
  font, weight 400, 16px line height, and 12px horizontal inner padding**.
  Set width in the consumer's layout. Multiline fields retain the component's
  existing multiline sizing.
- Reuse `NeumorphicTextField.module.css` and its `NeumorphicSurface` wrapper
  with `raised` and `highlightFocus`. Normal background uses
  `--neumorphic-button-surface`, with a 1px `--divider` border; hover and focus
  use the shared selection background (`--dropdown-selection-bg`, **#33464d
  in the dark theme**). Preserve theme tokens and the shared disabled state.
- Use the component's background highlight for input focus; do not add the
  legacy input's gradient or thick outer focus ring. Placeholder text inherits
  the control color at the component's existing 0.64 opacity.
- For an input clear X, pass `SearchClearButton` through `trailingAction`.
  Match the tab close button's color, background, hover, and keyboard-focus
  treatment using the compact standard above: **18px circular button, 9px
  icon, stroke width 1.7**. Keep it vertically centered at the right, with
  `--icon-default` inset and the component's 34px trailing text padding.
- Apply this standard to new or modified inputs within the requested scope;
  keep input behavior, refs, keyboard shortcuts, and intentional layout widths.

## Shared tabs

- Use `FlatTabList` and `FlatTab` from `frontend/src/shared/ui` for closable
  workspace tabs, including editor files and terminal sessions. Keep their
  common appearance in `frontend/src/shared/ui/FlatTab.module.css`.
- Tabs are adjoining rectangles with no gaps or rounded corners, a right-hand
  divider, and a 160px minimum / 240px maximum width. Truncate long labels with
  an ellipsis while retaining the full title.
- Leading file and terminal icons stay **11px × 11px with stroke width 1.7**.
  Do not apply scale or enlargement effects on activation or hover. Labels are
  **11px, weight 500 (Medium), system UI font, 15px line height**.
- While a tab is active, continuously blink only the icon's internal lines
  (the terminal underline or the file's text lines) on a **0.8s linear cycle**,
  with opacity **1 → 0 → 1**. Keep the icon outline and tab indicator static.
- Inactive tabs stop the icon animation and show all lines at full opacity;
  hovering an inactive tab must not start it. Disable the animation under
  `prefers-reduced-motion: reduce`.
- Active tabs have a transparent background, including on hover, and a **2px
  bottom indicator**. Inactive tabs use the selection background on hover.
- Use `--dropdown-selection-bg` for both the indicator and hover background,
  matching the Explorer selection background (**#33464d in the dark theme**).
  Reuse the token so the colors stay consistent across themes.
- Show the circular close X on active or hovered tabs. Otherwise hide it while
  reserving its space so tab widths remain stable. Use the compact close-button
  standard above: **18px button, 9px icon, stroke width 1.7**.

## Shared count badges

- Use the Problems and Git Local changes count badges as the common badge
  style. References: `.workspace-editor-problems-title > span` in
  [workspace-editor-problems.css](frontend/src/features/editor/workspace-editor-problems.css)
  and `.changeCountBadge` in
  [GitWorkspace.changes.css](frontend/src/features/git/GitWorkspace.changes.css)
  and [GitWorkspace.layout.css](frontend/src/features/git/GitWorkspace.layout.css).
- Show a count badge only when **`count > 0`**. Hide the entire badge at zero,
  including its border, background, and reserved space.
- Use **14px height, 18px minimum width, 10px corner radius, and 5px horizontal
  padding**. Center the number with `inline-flex`, `align-items: center`,
  `justify-content: center`, and `flex: 0 0 auto`.
- Use the inherited UI font family with **8px size, weight 400, normal font
  style, 12px line height, and tabular numerals**.
- Use **1px `var(--divider)` border**, `var(--neumorphic-button-surface)`
  background, and **`#929b9e` text**. Apply `neumorphic-surface-tokens` directly
  or compose it from global in a CSS Module so the background follows the theme.
- Keep the same neutral appearance for positive counts. Apply this standard
  to new or modified count badges within the requested scope.

## Collapsible workspace panels

- Match the right sidebar and Problems panel when adding or changing a
  collapsible workspace panel. References: `.right-sidebar-column` in
  [styles.css](frontend/src/styles.css) and the stage/panel rules in
  [workspace-editor-problems.css](frontend/src/features/editor/workspace-editor-problems.css).
- Animate layout size and `transform` with **200ms `ease`**, and `opacity`
  with **160ms `ease`**, for both opening and closing. Slide toward the panel's
  outer edge: `translateX(100%)` for the right sidebar and `translateY(100%)`
  for the bottom panel; open panels use zero translation and opacity 1.
- Keep the panel mounted across open/close toggles so the closing transition
  can finish. Drive CSS with an explicit open-state attribute. Collapse its
  allocated layout space to zero while closing, using compatible flex sizes
  or grid tracks, and clip overflow. Restore the saved size when reopening.
- The Problems split keeps three grid rows: editor, separator, panel. Its
  closed state is `minmax(0, 1fr) 0px minmax(0, 0fr)`. Keep the track structure
  consistent so `grid-template-rows` can transition smoothly.
- Closed panels use **`aria-hidden`, `inert`, and `pointer-events: none`**.
  Their resize handles must also be hidden and unavailable to pointer and
  keyboard interaction. Keep the toggle's `aria-expanded` synchronized.
- Disable layout transitions during pointer resizing so the panel follows
  the pointer immediately. Preserve resize limits and the user's chosen size.
- Under **`prefers-reduced-motion: reduce`**, disable panel and layout
  transitions. Use CSS transitions rather than delayed unmount timers.
- Reuse `LiquidGlassPanel` for reusable panel wrappers and its shared border,
  radius, and backdrop rules. Flush wrappers use `--liquid-glass-radius: 0`.
  Let the common application background show through unless the panel has an
  intentional surface treatment; do not add a redundant background tint.
