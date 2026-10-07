# Desktop Instructions

These instructions apply to `desktop/` and its descendants, together with the
repository root instructions.

## Button styles

Text buttons use the following two styles.

### Shared specifications

- Use a total height of `32px` with `box-sizing: border-box`.
- Use no border.
- Use `var(--font-size-label)` (`11px`) for the font size.
- Use `var(--text)` (`#D3E2DE`) for the text color.
- Preserve the height, border, font size, and text color in the default, hover,
  and pressed states.
- Enabled buttons use `cursor: pointer`.

### Standard button

- Default background: `var(--control-surface)`
  (`rgba(41, 52, 61, 0.4)`).
- Hover and pressed background: `var(--control-surface-interactive)`
  (`rgba(41, 52, 61, 0.8)`).

### Ghost button

Use the Ghost style for secondary actions that do not need a prominent
background.

- Default background: `var(--control-surface-ghost)`
  (`rgba(41, 52, 61, 0.05)`).
- Hover and pressed background: `var(--control-surface-interactive)`
  (`rgba(41, 52, 61, 0.8)`).

Provide both styles through shared button components and reuse those components.
Icon-only buttons and switches follow their separately defined specifications.

## Circle button styles

Classify circular action buttons that display only an icon as `circle-button`.

### Shared specifications

- Use `var(--icon-button-size)` (`22px`) for both width and height, with
  `box-sizing: border-box`.
- Use no border.
- Use a `50%` border radius.
- Use zero inner padding.
- Use `var(--icon-button-icon-size)` (`11px`) for both icon dimensions and
  `var(--icon-button-stroke-width)` (`1.7`) for the stroke width.
- Use `var(--text)` (`#D3E2DE`) for the icon color.
- Center the icon horizontally and vertically.
- Preserve the size, shape, and icon color in the default, hover, and pressed
  states.
- Do not translate or scale the button when it is clicked.
- Do not show a focus outline.
- Enabled buttons use `cursor: pointer`.

### Standard circle button

- Default background: `var(--control-surface)`
  (`rgba(41, 52, 61, 0.4)`).
- Hover and pressed background: `var(--control-surface-interactive)`
  (`rgba(41, 52, 61, 0.8)`).

### Ghost circle button

Use the Ghost style for secondary actions that do not need a prominent
background.

- Default background: `var(--control-surface-ghost)`
  (`rgba(41, 52, 61, 0.05)`).
- Hover and pressed background: `var(--control-surface-interactive)`
  (`rgba(41, 52, 61, 0.8)`).

### Disabled state and accessibility

- Disabled buttons use `disabled`, `opacity: 0.5`, and
  `cursor: not-allowed`.
- Do not apply hover or pressed effects to disabled buttons.
- Use Lucide icons.
- Provide an `aria-label` and a tooltip that describe the action.
- Apply `aria-hidden="true"` to decorative icons.
- Preserve native button keyboard interaction.

Provide the Standard and Ghost styles through shared circle-button components
and reuse those components. Controls with separate specifications, including
switches and tab-close buttons, follow their own standards.

## Shared popup backgrounds

Reuse [PopupSurface styles](frontend/src/shared/ui/PopupSurface.module.css)
and [LiquidGlassPanel](frontend/src/shared/ui/LiquidGlassPanel.tsx) for layered
popup surfaces. Item hover, selection, and pressed backgrounds follow their
control-specific rules independently.
Modal dialogs use the separate [shared modal](#shared-modal) rules below.

### Layered background

- Keep two layers: a rear decorative background and the foreground popup panel.
- Compose `PopupSurface.module.css`'s `anchor` on the positioning wrapper and
  `surface` on the panel, directly or through `ToolbarMenu.module.css`.
  The anchor owns `::before` with `inset: 0`, `z-index: -1`, and
  `pointer-events: none`; consumers own placement, dimensions, and stacking.
- Use the implemented surface properties: `--popup-rear-background` defaults
  to `transparent` and `--popup-surface-background` defaults to
  `var(--overlay-surface)` (`transparent`). Keep both layers transparent.
  The composer, modal, shared menus, and default select popup use the same token.
  Do not restore the removed `rgba(41, 52, 61, 0.2)` tint or obsolete black
  `0.01` fills.
- Use `LiquidGlassPanel` for the foreground panel. Its `role="menu"`,
  `role="listbox"`, or `data-liquid-glass-backdrop="true"` enables participation
  in the shared blur system. Preserve the correct accessibility role; use the
  data attribute for a surface that needs blur without menu/listbox semantics.
  Retain the shared `1px solid var(--divider)` border.
- Match both layers' radius with
  `var(--liquid-glass-radius, var(--panel-radius))`.
- Apply translucency to background colors, not the entire popup's `opacity`.
  Keep text and icons sharp; do not apply `filter: blur()` to popup contents.
- Keep the overlay in the existing HTML portal. Do not introduce a separate
  native window for this effect.

### Transparent SVG blur in chat

- Follow [ChatConfigurationMenu styles](frontend/src/features/chat/ChatConfigurationMenu.module.css)
  for the model, reasoning, and service-tier menu and its submenus. Set
  `--popup-rear-background: transparent` and
  `--popup-surface-background: var(--overlay-surface)` on the anchor. Submenu anchors
  inherit these properties. The temporary-chat configuration menu shares these
  styles. Keep item hover/selection backgrounds independent of panel transparency.
- [ChatViewSurface](frontend/src/features/chat/ChatViewSurface.tsx) supplies
  [RegionalBlur](frontend/src/shared/ui/RegionalBlur.tsx) with the timeline's
  `sourceRef`. React context crosses portals, so the composer and floating menus
  use the same source. Keep foreground panels outside that source's DOM subtree
  and inside the provider's React tree.
- `RegionalBlur` applies SVG `feGaussianBlur` with `stdDeviation="16"` to the
  source only within the registered panels' rounded footprints. Its masked
  arithmetic composition replaces scene pixels rather than drawing a second
  translucent copy. Reuse this implementation instead of copying the scene or
  adding a separate blur filter per menu.
- [regionalBlurController](frontend/src/shared/ui/regionalBlurController.ts)
  manages registration, geometry updates, and restoration. It owns
  `data-regional-blur-surface="true"`; do not set this attribute manually.
  [LiquidGlassPanel styles](frontend/src/shared/ui/LiquidGlassPanel.module.css)
  disable native backdrop filtering on both layers of registered panels.
  Keep both panel layers free of tint. Do not reintroduce native
  `backdrop-filter` or saturation: native backdrop filtering previously darkened the
  transparent Electron window.
- SVG blur covers only the supplied source, not arbitrary content behind the
  window. Outside a connected `RegionalBlur` provider, existing popup styles
  retain their native backdrop fallback (the shared anchor defaults to `16px`
  plus the saturation token). Transparent CSS alone does not establish SVG blur.
  Extending this treatment to another scene requires connecting its background
  source and verifying the overlay; do not assume all app menus are migrated.

CodeMirror popups retain their existing DOM and positioning. Reuse the shared
panel CSS through the foreground surface installed by
[workspaceEditorTooltips](frontend/src/features/editor/workspaceEditorTooltips.ts).
Preserve its border-aligned `inset: -1px` layers and rear/foreground z-indexes
of `-2`/`-1`, defined in
[workspaceEditorTheme](frontend/src/features/editor/workspaceEditorTheme.ts).

## Shared modal

Use [Modal](frontend/src/shared/ui/Modal.tsx), exported from
`frontend/src/shared/ui`, for application modal dialogs. Keep feature-specific
content, actions, and sizing in the consumer. Reuse the common module instead of
creating another dialog shell, dimming overlay, or blur implementation.

### Background and blur

- `Modal` renders a native `<dialog>` through a portal to `document.body`.
  Its foreground is a `LiquidGlassPanel` with `var(--overlay-surface)`
  (`transparent`); the dialog shell and decorative rear layer remain
  transparent. Retain the shared border
  and rounded corners from [Modal styles](frontend/src/shared/ui/Modal.module.css).
- [modalBlur](frontend/src/shared/ui/modalBlur.ts) manages the background sources
  and modal stack. [modalBlurFilter](frontend/src/shared/ui/modalBlurFilter.ts)
  applies an SVG blur of `16px` to the scene behind the active modal, then an
  additional `16px` only within the modal's rounded footprint. The region mask
  follows the modal and source dimensions.
- The regional result replaces the corresponding scene pixels. Do not layer
  another blurred copy over them: duplicate background composition previously
  caused unwanted darkening in the transparent Electron window.
- Keep modal content, text, and buttons sharp. Do not add `backdrop-filter`,
  saturation filters, opaque fills, or `data-liquid-glass-backdrop="true"` to
  the modal panel or its decorative rear layer. Do not apply the popup background
  recipe above to modals.
- Keep the separate native `::backdrop` dimming color at
  `rgba(0, 0, 0, 0.16)`. Only the active modal owns this dimming layer; lower
  modal backdrops are transparent. Let the shared controller handle nesting,
  source restoration, and filter cleanup.

### Content and controls

- For new confirmation dialogs, explicitly pass `headerVariant="section"` and
  `closeButtonVariant="ghost"`. This uses the shared section title and ghost
  circle X button; the component's existing defaults do not imply a ghost button.
- Use left-aligned body text and the shared description typography. In the
  delete-chat confirmation, place the deletion description and
  `This cannot be undone.` on separate lines; allow further wrapping in narrow
  windows. Keep the action buttons right-aligned.
- Follow [ChatDeleteSessionDialog](frontend/src/features/chat/ChatDeleteSessionDialog.tsx)
  and [its styles](frontend/src/features/chat/ChatSplitDialog.module.css) for this
  confirmation layout. Use the existing `--modal-width`, `--modal-header-height`,
  `--modal-header-padding`, and `--modal-content-padding` properties for layout.
- Preserve native modal focus containment, Escape/outside-click dismissal, and
  focus restoration. Pass `closeDisabled` while dismissal is blocked, and keep
  feature actions guarded during pending operations.
- Validate shared modal changes with
  [modal blur tests](test/modal-blur.test.tsx) and the affected dialog tests.
  Follow the repository's authorization rules for rendered development-app review;
  check foreground sharpness, background color, resizing, nesting, and restoration.

## Dropdown menu styles

Use a dropdown menu for actions such as File actions. A Select chooses a value;
keep its selection semantics separate from action menus.

### Shared modules

| Purpose | Module and usage |
| --- | --- |
| Action menu | [ToolbarMenu](frontend/src/shared/ui/ToolbarMenu.tsx): pass `label` and `items` (`id`, `label`, `icon`, `onSelect`, optional `disabled`, `shortcut`, `separatorBefore`). Import directly from its module. It owns the trigger, portal, placement, dismissal, keyboard navigation, and focus restoration. |
| Value dropdown | [LiquidGlassSelect](frontend/src/shared/ui/LiquidGlassSelect.tsx), exported from `shared/ui`: pass `ariaLabel`, `value`, `options`, and `onChange`. Use `menuAppearance="toolbar"` for shared toolbar menu styling; choose `triggerAppearance`, `menuPlacement`, and `menuWidth` through its existing props. Preserve its `menuitemradio` / `aria-checked` selection semantics. |
| Dropdown trigger only | [PillDropdownButton](frontend/src/shared/ui/PillDropdownButton.tsx), exported from `shared/ui`: a pill button with a chevron. It does not provide a popup, positioning, or menu interactions. |
| Specialized nested chat menu | [ChatConfigurationMenu](frontend/src/features/chat/ChatConfigurationMenu.tsx) and [TemporaryChatConfigurationMenu](frontend/src/features/chat/TemporaryChatConfigurationMenu.tsx): feature-owned contents and state using the shared panel and menu styles. Preserve root `menuitem` and submenu `listbox` / `option` semantics. |

Reuse these components rather than building another dropdown shell. For specialized
menus, compose [ToolbarMenu styles](frontend/src/shared/ui/ToolbarMenu.module.css)
and use `LiquidGlassPanel`; keep feature-specific layout and state in the consumer.
`LiquidGlassSelect` retains its existing default appearance unless
`menuAppearance="toolbar"` is selected. Its portal stays inside the nearest native
dialog when present; preserve that behavior so modal selects remain interactive.
Apply the [shared popup backgrounds](#shared-popup-backgrounds) above.

### Menu contents

- Use the `section-title` style for the menu title.
- Use `32px` item heights, `var(--font-size-label)` (`11px`) text, and
  `var(--text)` for item text and icons. Keep these consistent across states.
- Use `var(--control-surface-ghost)` for item backgrounds and
  `var(--control-surface-interactive)` for enabled hover, pressed, and keyboard
  focus states. Preserve shared disabled behavior.
- Retain shared menu keyboard navigation, Escape/outside-click dismissal, and
  focus restoration to the trigger.
- For behavior changes, run the affected [toolbar menu](test/toolbar-menu.test.tsx)
  or [select](test/liquid-glass-select.test.tsx) tests. For SVG blur integration,
  include [regional blur](test/regional-blur.test.tsx) and affected feature tests.
  Rendered review follows the repository's UI authorization rules; check open
  menus and submenus, background transparency, sharp text, placement, and cleanup.

## Text styles

Text uses one of the following three styles according to its role.

| Style | Size | Weight | Color |
| --- | --- | --- | --- |
| `section-title` | `var(--font-size-section-title)` (`10px`) | `600` | `var(--sidebar-section-label-color)` |
| `description` | `var(--font-size-small)` (`10px`) | `400` | `var(--sidebar-section-label-color)` |
| `setting-label` | `var(--font-size-label)` (`11px`) | `400` | `var(--text)` |

- Use `section-title` for setting groups and section titles. Reuse
  `--font-size-section-title` for their size; keep `--font-size-label` at `11px`
  for controls and setting labels.
- Use `description` for descriptions below titles, help text, and status
  guidance.
- Use `setting-label` for the names of settings such as switches and sliders.
  A current value displayed with a setting uses the same style.
- Use `var(--font-ui), sans-serif` as the shared UI font.
- Keep letter spacing at `normal`.
- Use the specified tokens instead of fixed hexadecimal values for colors.

## Settings detail layout

Keep settings detail pages on the shared spacing rhythm used by the Appearance
and Agents views in `frontend/src/features/settings/`.

- Apply `var(--space-default)` as the detail scroll area's inner padding and as
  the gap between direct form sections. Do not replace this rhythm with
  feature-specific margins.
- Use a flex title row with a `32px` minimum height, centered items,
  `justify-content: space-between`, and a `var(--space-default)` gap. Wrap a
  `section-title` in this row even when it has no trailing action so its text
  aligns with titles that include a button.
- Use a `36px` minimum height for setting and input rows and center their labels
  and controls vertically.
- When a description, loading message, or status belongs to one logical block,
  stack those messages vertically with a `var(--space-default)` gap instead of
  letting consecutive text lines collapse together.
- Reuse the `section-title`, `description`, and `setting-label` styles defined
  above for all text in these rows.

## Sidebar navigation items

Classify items that switch views, such as settings categories, as
`sidebar-nav-item`. Reuse the shared button style with the following
specifications.

### Shared specifications

- Use `100%` width.
- Use a total height of `42px` with `box-sizing: border-box`.
- Use no border.
- Use zero border radius.
- Use `var(--icon-button-icon-size)` (`11px`) for both icon dimensions.
- Use `var(--font-size-label)` (`11px`) for the font size, with a weight of
  `400`.
- Use `var(--text)` for both text and icon colors.
- Preserve the dimensions and text and icon colors in every state.
- Clickable items use `cursor: pointer`.

### State backgrounds

- Default: `var(--control-surface-ghost)` (`rgba(41, 52, 61, 0.05)`).
- Selected: `var(--control-surface)` (`rgba(41, 52, 61, 0.4)`).
- Hover and pressed: `var(--control-surface-interactive)`
  (`rgba(41, 52, 61, 0.8)`).

Mark the currently selected item with `aria-current="page"`. Distinguish the
selected state from the momentary `:active` pressed state. The hover and
pressed backgrounds take precedence on selected items; restore the selected
background when the interaction ends.

## Scrollbars

Apply the same rules to both horizontal and vertical scrollbars in sidebars
and editors, including read-only editor views.

- Keep the thickness fixed at `6px` through `--auto-hide-scrollbar-size`:
  width for vertical scrollbars and height for horizontal scrollbars.
- Show the scrollbar immediately on scroll. Each new scroll restarts the
  `700ms` idle delay and cancels any fade in progress.
- After `700ms` without scrolling, fade the thumb to transparent over `240ms`
  with `ease-out`. Keep the track transparent.
- Control visibility and fading in the application instead of relying on
  Chromium or macOS automatic scrollbar behavior.
- Preserve scrollbar dimensions and content spacing while hiding. Do not
  remove the scrollbar or change its thickness to hide it.
- Under `prefers-reduced-motion: reduce`, keep the idle delay and immediate
  redisplay, but disable the fade animation.
- Reuse [the shared scrollbar styles](frontend/src/shared/styles/scrollbars.css)
  and [the activity lifecycle](frontend/src/shared/useAutoHideScrollbars.ts).
  React panels use `useAutoHideScrollbars`; editor views use
  `installAutoHideScrollbars` through
  [the CodeMirror extension](frontend/src/features/editor/workspaceEditorScrollbars.ts).
  Avoid separate feature-specific timers or fade implementations.
- Fixed-size scroll containers set
  `--scrollbar-size: var(--auto-hide-scrollbar-size)`, `scrollbar-width: auto`,
  and `scrollbar-color: auto` so native styling does not override the shared
  thickness and thumb colors.

## Toggle switches

Use `toggle-switch` for on/off settings.

### Appearance

- Use a `36px × 20px` size.
- Use no border.
- Use a `10px` border radius.
- Use a circular `20px × 20px` thumb in `var(--control-thumb-color)`
  (`#FFFFFF`).
- Use `var(--control-track-color)` (`#A6A6A6`) for the off-state background.
- Use `var(--toggle-track-on-color)` (`#18A9CF`) for the on-state background.
- Preserve the current shape and colors on hover.
- Do not show a focus outline.

### Behavior

- Position the thumb on the left in the off state.
- Move the thumb `16px` to the right in the on state.
- Animate thumb movement with `transform 160ms ease`.
- Disable the animation under `prefers-reduced-motion: reduce`.
- Expose the state with `role="switch"` and `aria-checked`.
- Support an associated label and native keyboard interaction.
- Disabled switches use `opacity: 0.5` and `cursor: not-allowed`.
- Enabled switches use `cursor: pointer`.

## Sliders

Use `slider` for settings that adjust a continuous numeric value.

### Appearance

- Use a `200px` width and `20px` height for the control.
- Apply `max-width: 100%` in narrow layouts.
- Use a transparent control background.
- Use no border.
- Use a `4px` track height with a `2px` border radius.
- Use `var(--control-track-color)` (`#A6A6A6`) for the default track.
- Use `var(--control-track-hover-color)` (`#B8B8B8`) for the hovered track.
- Use a circular `20px × 20px` thumb in `var(--control-thumb-color)`
  (`#FFFFFF`).
- Center the thumb vertically on the track.
- Use one color across the full track. Do not add a separate filled color for
  the completed portion.
- Do not show a focus outline.

### Behavior

- Use a native `input[type="range"]` to preserve keyboard interaction.
- Define the minimum, maximum, and unit for each setting.
- During dragging, move the thumb immediately with the input position and do
  not add a movement animation.
- Display the current value with the associated setting label.
- Disabled sliders use `opacity: 0.5` and `cursor: not-allowed`.
- Enabled sliders use `cursor: pointer`.

Labels for toggle switches and sliders follow the `setting-label`
specification. All dimensions use CSS pixels rather than physical pixels from a
screenshot.

## Input field styles

Reuse the shared input component for single-line input fields and apply the
following specifications.

### Shared specifications

- Use a total height of `32px` with `box-sizing: border-box`.
- Use no border.
- Use a pill shape with `border-radius: 999px`.
- Use `var(--font-ui), sans-serif` as the font.
- Use `var(--font-size-label)` (`11px`) for the font size, with a weight of
  `400`.
- Use `var(--text)` (`#D3E2DE`) for the text color.
- Use the same color for placeholder text with `opacity: 0.4`.
- Use the `text` cursor in the editable input area.
- Do not show a focus outline.

### State backgrounds

- Default: `var(--control-surface)` (`rgba(41, 52, 61, 0.4)`).
- Hover, focus, and pressed: `var(--control-surface-interactive)`
  (`rgba(41, 52, 61, 0.8)`).

Preserve the height, border, corner shape, font size, and text color in every
state. Do not translate or scale an input when it is clicked. Apply
transparency only to the background; do not reduce the opacity of the entire
input. Preserve the shared component's disabled treatment and do not apply
interaction effects while disabled. Multiline inputs use separate height and
corner specifications.
