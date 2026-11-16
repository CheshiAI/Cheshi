import type { Plugin } from 'vite';

function replace(source: string, from: string, to: string, file: string): string {
  if (!source.includes(from)) throw new Error(`OpenPencil integration needs review: ${file}: ${from}`);
  return source.replace(from, to);
}

/** Adapt the pinned source at build time; the downloaded repository stays intact. */
export function originalEditorAdaptations(): Plugin {
  return {
    name: 'cheshi-original-editor-presentation', enforce: 'pre',
    transform(source, id) {
      if (id.includes('?')) return null;
      const file = id.split('?')[0]!;
      if (!file.includes('/vendor/open-pencil/')) return null;
      let result = source;
      const swap = (from: string, to: string) => { result = replace(result, from, to, file); };
      const remove = (pattern: RegExp) => {
        const match = result.match(pattern)?.[0];
        if (!match) throw new Error(`OpenPencil integration needs review: ${file}: ${pattern}`);
        swap(match, '');
      };
      if (file.endsWith('/packages/core/src/constants.ts')) {
        swap('RULER_SIZE = 20', 'RULER_SIZE = 16');
        swap('RULER_BADGE_HEIGHT = 14', 'RULER_BADGE_HEIGHT = 10');
        swap('RULER_TEXT_BASELINE = 0.65', 'RULER_TEXT_BASELINE = 0.66875');
        for (const name of ['LABEL_FONT_SIZE', 'VALUE_FONT_SIZE', 'SECTION_TITLE_FONT_SIZE', 'COMPONENT_LABEL_FONT_SIZE']) {
          swap(`export const ${name} = 11`, `export const ${name} = 10`);
        }
      } else if (file.endsWith('/packages/core/src/canvas/rulers.ts')) {
        swap('  canvas.drawRect(r.ck.LTRBRect(0, 0, R, R), r.rulerBgPaint)', '');
        swap('  if (!font) return', '  if (!font) return\n  const previousFontSize = font.getSize()\n  font.setSize(9)\n  try {');
        swap('  drawGuideRulerPositions(r, canvas, graph, font, guides)\n}', '  drawGuideRulerPositions(r, canvas, graph, font, guides)\n  } finally { font.setSize(previousFontSize) }\n}');
        swap('rulerLabel(wy), 0, 3,', 'rulerLabel(wy), 0, 2.7,');
      } else if (file.endsWith('/packages/vue/src/canvas/surface/lifecycle.ts')) {
        // Keep document page colors intact while revealing Cheshi's CSS dot grid.
        swap('      view,\n      editor.graph,', '      { ...view, pageColor: { r: 0, g: 0, b: 0, a: 0 } },\n      editor.graph,');
        // CanvasKit unregisters its handle, but Chromium keeps the WebGL context
        // alive until GC. Release it only on final disposal, never when rebuilding
        // the surface on the same canvas after a color-space change.
        swap('  function destroy() {\n    stopStickyPlaceholder()',
          `  function destroy() {
    const canvas = state.glCanvas
    const gl = canvas ? (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) : null
    stopStickyPlaceholder()`);
        swap('    releaseGLContext()\n  }\n\n  return {',
          `    releaseGLContext()
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  }

  return {`);
      } else if (file.endsWith('/packages/core/src/editor/viewport.ts')) {
        // An embedded editor can briefly have no layout size. Never persist a
        // zero zoom: resizing later redraws with that same invalid transform.
        swap('    const zoom = Math.min(viewW / w, viewH / h, 1)',
          `    if (![viewW, viewH, w, h].every(value => Number.isFinite(value) && value > 0)) return
    const zoom = Math.max(0.02, Math.min(viewW / w, viewH / h, 1))`);
      } else if (file.endsWith('/src/app/document/io/create.ts')) {
        swap('    setPlannedFilePath: sourceActions.setPlannedFilePath,',
          `    setPlannedFilePath: sourceActions.setPlannedFilePath,
    retargetDocumentSource: (path: string) => {
      sourceActions.setPlannedFilePath(path)
      sourceState.setSourceIdentity({ handle: null, path })
      sourceActions.startWatchingCurrentFile()
    },`);
      } else if (file.endsWith('/src/app/editor/session/modules.ts')) {
        swap('    setPlannedFilePath: documentIO.setPlannedFilePath,',
          '    setPlannedFilePath: documentIO.setPlannedFilePath,\n    retargetDocumentSource: documentIO.retargetDocumentSource,');
      } else if (file.endsWith('/src/app/document/io/browser.ts')) {
        swap('export function createDocumentViewportActions(editor: ViewportEditor, viewportSize: ViewportSize) {',
          `export function createDocumentViewportActions(editor: ViewportEditor, viewportSize: ViewportSize) {
  let fitPending = false`);
        swap('    viewportSize.height = height', `    viewportSize.height = height
    if (fitPending && width > 0 && height > 0) {
      fitPending = false
      void fitCurrentPageToViewport()
    }`);
        swap('    await yieldToUI()\n    editor.zoomToFit()', `    await yieldToUI()
    if (!(viewportSize.width > 0 && viewportSize.height > 0)) {
      fitPending = true
      return
    }
    fitPending = false
    editor.zoomToFit()`);
      } else if (file.endsWith('/packages/vue/src/canvas/surface/resize-observer.ts')) {
        // ResizeObserver runs after layout and before paint. Deferring one frame
        // stretches the previous bitmap while an adjacent panel animates.
        swap('  let resizeRaf = 0', '  let stopped = false');
        swap('    cancelAnimationFrame(resizeRaf)', '    stopped = true');
        swap(`    if (!canvas || !getCanvasKitValue() || resizeRaf) return
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      resizeCanvas(canvas)
    })`, `    if (!canvas || !getCanvasKitValue() || stopped) return
    resizeCanvas(canvas)`);
      } else if (file.endsWith('/packages/core/src/canvas/labels/style.ts')) {
        // Transparent presentation sits over Cheshi's dark CSS surface. Use its
        // visible color for label contrast without changing document fills.
        const surface = '(r.pageColor.a === 0 ? { r: 8 / 255, g: 12 / 255, b: 13 / 255, a: 1 } : r.pageColor)';
        swap('canvasLabelForeground(background, r.pageColor)', `canvasLabelForeground(background, ${surface})`);
        swap('let background = r.pageColor', `let background = ${surface}`);
      } else if (file.endsWith('/packages/core/src/canvas/renderer/pipeline.ts') || file.endsWith('/packages/core/src/canvas/renderer/retained-backing.ts')) {
        const from = 'r.ck.Color4f(r.pageColor.r, r.pageColor.g, r.pageColor.b, 1)';
        if (!result.includes(from)) throw new Error(`Missing canvas clear in ${file}`);
        result = result.replaceAll(from, 'r.ck.Color4f(r.pageColor.r, r.pageColor.g, r.pageColor.b, r.pageColor.a)');
      } else if (file.endsWith('/src/components/brand/BrandMark.vue')) {
        swap('return `/brand/${sources[variant]}${suffix}.svg`', 'return new URL("./brand/mark.svg", document.baseURI).href');
      } else if (file.endsWith('/src/app/collab/context.ts')) {
        // Local page/presence controls can run without a collaboration provider.
        swap('return inject(COLLAB_KEY)', 'return inject(COLLAB_KEY, undefined)');
      } else if (file.endsWith('/src/components/home/search/HomeSearchActions.vue')) {
        swap("import HomeJoinRoom from './HomeJoinRoom.vue'", '');
        swap(`      <div class="col-span-2 grid md:contents">\n        <HomeJoinRoom :size="isMobile ? 'lg' : 'md'" />\n      </div>`, '');
      } else if (file.endsWith('/src/app/document/close/all.ts')) {
        swap("from './prompt'", "from '@/app/document/close/prompt'");
      } else if (file.endsWith('/src/App.vue')) {
        swap("import UnsavedChangesDialog from '@/components/document/UnsavedChangesDialog.vue'", '');
        swap('      <UnsavedChangesDialog />', '');
        swap("import VoiceCallAudio from '@/components/voice-call/VoiceCallAudio.vue'", '');
        swap('      <VoiceCallAudio />', '');
        swap("import AISetupDialog from '@/components/settings/ai-setup/AISetupDialog.vue'", '');
        swap('      <AISetupDialog />', '');
        swap("import SettingsDialog from '@/components/settings/SettingsDialog.vue'", '');
        swap('      <SettingsDialog />', '');
      } else if (file.endsWith('/src/components/TabBar.vue')) {
        swap('import { useTabsStore, createHomeTab }', 'import { useTabsStore }');
        remove(/function createNewTab\(event: MouseEvent\): void \{[\s\S]*?\n\}\n/);
        remove(/    <Tip :label="files\.newTab" side="bottom">[\s\S]*?    <\/Tip>\n/);
        swap("import tabBarTheme from '@/theme/tab-bar'", "import tabBarTheme from '@/theme/tab-bar'\nimport CanvasTitleMark from '@cheshi/CanvasTitleMark.vue'\nimport flatTabStyles from '@cheshi/flat-tab-styles'\nimport controlStyles from '@cheshi/control-styles'");
        swap('<icon-lucide-file v-else :class="baseStyles.icon()" />', '<CanvasTitleMark v-else />');
        swap(':class="baseStyles.list()"', ':class="[flatTabStyles.list, \'cheshi-canvas-tab-list\']"');
        swap(':class="tabBarStyles({ active: tab.isActive }).item()"', ':class="flatTabStyles.tab"');
        swap(':class="tabBarStyles({ active: tab.isActive }).trigger()"', ':class="flatTabStyles.trigger"');
        swap(':class="baseStyles.label()"', ':class="flatTabStyles.label"');
        swap(':class="tabBarStyles({ active: tab.isActive }).close()"',
          ':class="[controlStyles.control, flatTabStyles.close]" data-variant="ghost" data-size="icon"');
        swap(':class="baseStyles.closeIcon()"', 'aria-hidden="true"');
        swap(':class="baseStyles.icon()"', 'aria-hidden="true"');
      } else if (file.endsWith('/src/components/PagesPanel.vue')) {
        swap("import IconButton from '@/components/ui/button/IconButton.vue'",
          "import IconButton from '@/components/ui/button/IconButton.vue'\nimport controlStyles from '@cheshi/control-styles'");
        swap('<IconButton :label="panels.addPage"', '<IconButton :class="controlStyles.control" data-variant="ghost" data-size="icon" :label="panels.addPage"');
      } else if (file.endsWith('/src/components/design-check/PageIssueBadge.vue')) {
        swap("import { pageIssueBadge } from '@/theme/design-check'", "import badgeStyles from '@cheshi/badge-styles'");
        swap('const styles = computed(() => pageIssueBadge({ severity: severity.value }))', '');
        swap(':class="styles"', ':class="badgeStyles.badge"');
      } else if (file.endsWith('/src/components/LayersPanel.vue')) {
        // The host supplies the shared FILE heading; this panel only owns its
        // page list, resizable divider and layer tree.
        swap("import { computed, ref } from 'vue'", '');
        swap("import { useI18n, vTestId } from '@open-pencil/vue'", "import { useI18n } from '@open-pencil/vue'");
        swap("import AppMenu from '@/components/shell/AppMenu.vue'", '');
        swap("import SegmentedControl from '@/components/ui/select/SegmentedControl.vue'", '');
        swap("import AssetsPanel from './assets-panel/AssetsPanel.vue'", '');
        swap('const { menu, panels } = useI18n()', 'const { panels } = useI18n()');
        remove(/const activePanel = ref[\s\S]*?const panelTabsUI = \{ root: 'w-full' \}\n/);
        remove(/    <AppMenu \/>\n[\s\S]*?    <AssetsPanel v-if="activePanel === 'assets'" \/>\n/);
        swap('      v-else\n      direction="vertical"', '      direction="vertical"');
      } else if (file.endsWith('/src/components/properties/PageSection.vue')) {
        swap('<PanelSection :label="panels.page">', '<PanelSection :label="panels.page" data-property="page">');
        swap('<template #actions>', '<template v-if="variableModes.choices.value.length > 0" #actions>');
      } else if (file.endsWith('/src/components/properties/ExportSection.vue')) {
        swap('<PanelSection :label="panels.export"', '<PanelSection data-property="export" :label="panels.export"');
      } else if (file.endsWith('/src/components/properties/stroke/StrokeSection.vue')) {
        swap('<PanelSection :label="panels.stroke"', '<PanelSection data-property="stroke" :label="panels.stroke"');
      } else if (file.endsWith('/src/components/properties/EffectsSection.vue')) {
        swap('<PanelSection :label="panels.effects"', '<PanelSection data-property="effects" :label="panels.effects"');
      } else if (file.endsWith('/src/components/properties/layout/guides/LayoutGridSection.vue')) {
        swap('<PanelSection :label="panels.layoutGrids"', '<PanelSection data-property="layout-guides" :label="panels.layoutGrids"');
      } else if (file.endsWith('/src/components/properties/status/StatusSection.vue')) {
        swap("import IconButton from '@/components/ui/button/IconButton.vue'",
          "import IconButton from '@/components/ui/button/IconButton.vue'\nimport controlStyles from '@cheshi/control-styles'");
        for (const action of ['edit', 'add']) {
          swap(`data-test-id="status-${action}"`,
            `data-test-id="status-${action}" :class="controlStyles.control" data-variant="ghost" data-size="icon"`);
        }
      } else if (file.endsWith('/src/components/properties/TypographySection.vue')) {
        swap("import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'",
          "import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'\nimport switchStyles from '@cheshi/switch-styles'");
        swap('<AppSwitch\n', '<AppSwitch :ui="{ root: switchStyles.switch }"\n');
      } else if (file.endsWith('/src/components/settings/toolbar/ToolbarLayoutRow.vue')) {
        swap("import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'",
          "import switchStyles from '@cheshi/switch-styles'");
        swap(`    <AppSwitch
      :model-value="!hidden"
      :disabled="pinned"
      :label="settings.toolbarShow({ tool: label })"
      @update:model-value="emit('update:shown', $event)"
    />`, `    <button
      type="button"
      :class="switchStyles.switch"
      role="switch"
      :aria-checked="!hidden"
      :disabled="pinned"
      :aria-label="settings.toolbarShow({ tool: label })"
      @click="emit('update:shown', hidden)"
    ><span aria-hidden="true" /></button>`);
      } else if (file.endsWith('/src/components/color-picker-panel/RGBFields.vue')) {
        swap('  <div\n', '  <div data-slot="rgb-fields"\n');
      } else if (file.endsWith('/src/components/fill-picker/GradientEditor.vue')) {
        swap('    <div>\n', '    <div data-slot="gradient-editor">\n');
        swap('<AppSelect\n', '<AppSelect data-property="gradient-type"\n');
      } else if (file.endsWith('/src/components/fill-picker/ImageFillPicker.vue')) {
        swap('<AppSelect\n', '<AppSelect data-property="image-scale-mode"\n');
      } else if (file.endsWith('/src/components/fill-picker/shader/ShaderFillPicker.vue')) {
        swap('<AppCombobox\n', '<AppCombobox search-variant="standard"\n');
      } else if (file.endsWith('/src/components/comments/CommentsLayer.vue')) {
        swap("import { usePopoverUI } from '@/components/ui/overlay/popover'",
          `import { usePopoverUI } from '@/components/ui/overlay/popover'
import panelStyles from '@cheshi/panel-styles'
import popupStyles from '@cheshi/popup-styles'`);
        swap(':class="draftAt ? draftCls.content : threadCls.content"',
          `:class="draftAt ? [draftCls.content, panelStyles.panel, popupStyles.anchor, popupStyles.surface, 'cheshi-comment-draft'] : threadCls.content"
          :data-liquid-glass-backdrop="draftAt ? 'true' : undefined"`);
      } else if (file.endsWith('/src/components/comments/CommentComposer.vue')) {
        swap("import AppButton from '@/components/ui/button/AppButton.vue'",
          `import IconButton from '@/components/ui/button/IconButton.vue'
import fieldStyles from '@cheshi/text-field-styles'
import controlStyles from '@cheshi/control-styles'`);
        swap("import { comments } from '@/theme/comments'", '');
        swap('const ui = computed(() => comments({ bare }))', '');
        swap(':class="ui.composer()"',
          `:class="[fieldStyles.field, 'cheshi-comment-composer']" data-variant="standard" data-multiline="true" :data-bare="bare || undefined"`);
        swap(':class="ui.composerInput()"', ':class="fieldStyles.control" data-multiline="true"');
        swap(`    <AppButton
      type="submit"
      color="primary"
      variant="solid"
      shape="pill"
      size="xs"
      :disabled="empty"
      :aria-label="messages.send"
      :ui="{ base: 'size-6 shrink-0 px-0' }"
    >`, `    <IconButton type="submit" :disabled="empty" :label="messages.send"
      :class="controlStyles.control" data-variant="standard" data-size="icon">`);
        swap('</AppButton>', '</IconButton>');
      } else if (file.endsWith('/src/components/icon-picker/IconPicker.vue')) {
        swap('<AppCombobox\n', '<AppCombobox search-variant="standard"\n');
      } else if (file.endsWith('/src/components/ui/select/AppPicker.vue')) {
        swap("import theme, { APP_PICKER_GRID_COLUMNS } from '@/theme/select/picker'",
          `import theme, { APP_PICKER_GRID_COLUMNS } from '@/theme/select/picker'
import panelStyles from '@cheshi/panel-styles'
import popupStyles from '@cheshi/popup-styles'
import fieldStyles from '@cheshi/text-field-styles'
import controlStyles from '@cheshi/control-styles'`);
        swap(':class="styles.content({ class: ui?.content })"',
          `:class="[styles.content({ class: ui?.content }), layout === 'grid' && [panelStyles.panel, popupStyles.anchor, popupStyles.surface, 'cheshi-icon-picker']]"
        :data-liquid-glass-backdrop="layout === 'grid' ? 'true' : undefined"`);
        swap('<IconButton :label="closeLabel">',
          `<IconButton :label="closeLabel" :class="layout === 'grid' ? controlStyles.control : undefined"
              :data-variant="layout === 'grid' ? 'ghost' : undefined" :data-size="layout === 'grid' ? 'icon' : undefined">`);
        swap('<div :class="styles.search({ class: ui?.search })">',
          `<div :class="layout === 'grid' ? [fieldStyles.field, 'cheshi-icon-search'] : styles.search({ class: ui?.search })"
            :data-variant="layout === 'grid' ? 'standard' : undefined">`);
        swap(':class="styles.input({ class: ui?.input })"',
          `:class="layout === 'grid' ? fieldStyles.control : styles.input({ class: ui?.input })"`);
      } else if (file.endsWith('/src/components/ui/select/AppCombobox.vue')) {
        swap("import theme from '@/theme/select/combobox'",
          "import theme from '@/theme/select/combobox'\nimport fieldStyles from '@cheshi/text-field-styles'");
        swap('  searchPlaceholder?: string', "  searchPlaceholder?: string\n  searchVariant?: 'standard'");
        swap('  searchPlaceholder,\n', '  searchPlaceholder,\n  searchVariant,\n');
        swap('<div :class="styles.search({ class: ui?.search })">',
          `<div :data-variant="searchVariant"
          :class="searchVariant === 'standard' ? [fieldStyles.field, 'cheshi-combobox-search'] : styles.search({ class: ui?.search })">`);
        swap(':class="styles.input({ class: ui?.input })"',
          ':class="searchVariant === \'standard\' ? fieldStyles.control : styles.input({ class: ui?.input })"');
      } else if (file.endsWith('/src/components/properties/ExportScaleInput.vue')) {
        swap('class="flex min-w-0 flex-1 overflow-hidden rounded border border-border bg-input focus-within:border-panel-focus"',
          'data-slot="export-scale-field" class="flex min-w-0 flex-1 overflow-hidden rounded border border-border bg-input"');
        swap(':side-offset="4"', ':side-offset="0"');
      } else if (file.endsWith('/src/components/design-check/DesignCheckPanel.vue')) {
        swap("import { computed, useTemplateRef } from 'vue'", "import { useTemplateRef } from 'vue'");
        swap("import SegmentedControl from '@/components/ui/select/SegmentedControl.vue'\n", '');
        swap("import type { DesignCheckScope } from './types'\n", '');
        swap("const { active, initialScope = 'page' } = defineProps<{\n  active: boolean\n  /** The scope listed first; a host that shows one layer's problems can open on the selection. */\n  initialScope?: DesignCheckScope\n}>()",
          'const { active } = defineProps<{ active: boolean }>()');
        swap('  scope,\n', '');
        swap('useDesignCheckPanel({ active: () => active, list, initialScope })',
          "useDesignCheckPanel({ active: () => active, list, initialScope: 'page' })");
        remove(/const scopeOptions = computed[\s\S]*?\n\}\)\n/);
        swap('      <SegmentedControl v-model="scopeModel" :label="messages.scope" :options="scopeOptions" />\n', '');
        swap("import DesignCheckRulesMenu from './DesignCheckRulesMenu.vue'\n", '');
        swap("import SeverityFilters from './SeverityFilters.vue'\n", '');
        swap('  visibleSeverities,\n', '');
        swap('  counts,\n', '');
        remove(/^    <div :class="styles\.toolbar\(\)">[\s\S]*?^    <\/div>\n/m);
      } else if (file.endsWith('/src/components/design-check/DesignCheckRulesMenu.vue')) {
        swap("import IconButton from '@/components/ui/button/IconButton.vue'",
          "import IconButton from '@/components/ui/button/IconButton.vue'\nimport controlStyles from '@cheshi/control-styles'");
        swap('<IconButton size="xs" :label="messages.rules">',
          '<IconButton size="xs" :class="controlStyles.control" data-variant="ghost" data-size="icon" :label="messages.rules">');
      } else if (file.endsWith('/src/components/DesignPanel.vue')) {
        // Hide document-wide management summaries without changing document
        // variables, bindings, statuses, or the selected node's properties.
        swap("import { openVariablesDialog } from '@/app/editor/tokens/dialog'", '');
        swap("import VariablesSection from './properties/VariablesSection.vue'", '');
        swap("import StatusesSection from './properties/status/StatusesSection.vue'", '');
        swap('    <VariablesSection @open-dialog="openVariablesDialog(store)" />\n', '');
        swap('    <StatusesSection />\n', '');
      } else if (file.endsWith('/src/components/PropertiesPanel.vue')) {
        swap("import { useAIChat } from '@/app/ai/chat/use'", "import { activePropertiesTab as activeTab, canvasPanel } from '@cheshi/properties-tabs'");
        swap("import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'", '');
        swap("import { useDesignCheckMessages, useI18n } from '@open-pencil/vue'", '');
        swap("import { propertiesTabs } from '@/theme/panel/properties-tabs'", '');
        swap("import { countIssues } from '@/app/editor/design-check/issues'", '');
        swap("import ZoomDropdown from './editor/ZoomDropdown.vue'", '');
        swap('const { activeTab } = useAIChat()', '');
        swap('const { panels } = useI18n()', '');
        swap('const checkMessages = useDesignCheckMessages()', '');
        swap('const tabStyles = propertiesTabs()', '');
        swap("computed(() => store.state.activeTool === 'COMMENT')",
          "computed(() => activeTab.value === 'design' && store.state.activeTool === 'COMMENT')");
        remove(/\/\*\* Errors and warnings[\s\S]*?\n\}\)\n/);
        swap("import ChatPanel from './ChatPanel.vue'", '');
        swap("import CodePanel from './CodePanel.vue'", '');
        remove(/      <TabsList[\s\S]*?<\/TabsList>\n/);
        remove(/      <TabsContent\n        value="code"[\s\S]*?<\/TabsContent>\n/);
        remove(/      <TabsContent\n        value="ai"[\s\S]*?<\/TabsContent>\n/);
        swap('<TabsRoot', '<div');
        swap('      v-model="activeTab"\n', '');
        swap('</TabsRoot>', '</div>');
        for (const tab of ['design', 'lint']) {
          swap(`<TabsContent\n        value="${tab}"`, `<div\n        data-test-id="canvas-${tab}-content"`);
          swap('        :force-mount="true"\n', '');
          swap(`:hidden="activeTab !== '${tab}'"`, `v-show="activeTab === '${tab}'"`);
          swap('</TabsContent>', '</div>');
        }
        swap(':active="activeTab === \'lint\'"', ':active="canvasPanel.panelOpen && activeTab === \'lint\'"');
      } else if (file.endsWith('/src/theme/panel/field/base.ts')) {
        swap("'h-6 min-w-0", "'cheshi-property-field h-6 min-w-0");
        swap("'flex size-6", "'cheshi-property-icon flex size-6");
      } else if (file.endsWith('/src/components/MobileDrawer.vue')) {
        swap("import CodePanel from './CodePanel.vue'", '');
        swap("type DrawerTab = 'layers' | 'design' | 'code' | 'ai'", "type DrawerTab = 'layers' | 'design' | 'ai'");
        swap("  if (store.state.activeRibbonTab === 'code') return 'code'\n", '');
        swap("  if (tab === 'code' || tab === 'ai') {", "  if (tab === 'ai') {");
        remove(/          <TabsTrigger\n            data-test-id="mobile-ribbon-code"[\s\S]*?<\/TabsTrigger>\n/);
        remove(/        <TabsContent value="code"[\s\S]*?<\/TabsContent>\n/);
      } else if (file.endsWith('/src/components/toolbar/ToolButton.vue')) {
        swap("import toolbarTheme from '@/theme/toolbar'", "import toolbarTheme from '@/theme/toolbar'\nimport controlStyles from '@cheshi/control-styles'");
        swap(':class="styles.button({ class: ui?.button })"',
          ':class="[styles.button({ class: ui?.button }), !mobile && controlStyles.control]" :data-size="mobile ? undefined : \'icon\'" data-variant="ghost"');
      } else if (file.endsWith('/src/components/toolbar/ToolFlyout.vue')) {
        swap("import toolbarTheme from '@/theme/toolbar'", "import toolbarTheme from '@/theme/toolbar'\nimport controlStyles from '@cheshi/control-styles'");
        swap(':class="styles.flyoutTrigger({ class: ui?.flyoutTrigger })"',
          ':class="[styles.flyoutTrigger({ class: ui?.flyoutTrigger }), !mobile && controlStyles.control]" :data-size="mobile ? undefined : \'icon\'" data-variant="ghost"');
      } else if (file.endsWith('/src/components/toolbar/DesktopToolbar.vue')) {
        swap("import { ToolbarRoot } from 'reka-ui'", "import { ToolbarRoot } from 'reka-ui'\nimport panelStyles from '@cheshi/panel-styles'");
        swap('class="flex gap-0.5 rounded-xl bg-panel p-1 shadow-[0_8px_30px_rgb(0_0_0/0.4)]"',
          ':class="panelStyles.panel" class="flex gap-0.5 bg-panel p-1" data-liquid-glass-backdrop="true"');
      } else if (file.endsWith('/src/components/EditorCanvas.vue')) {
        swap("import { useAIChat } from '@/app/ai/chat/use'", "import { activePropertiesTab as propertiesTab } from '@cheshi/properties-tabs'");
        swap('const { activeTab: propertiesTab } = useAIChat()', '');
        // Keep preparation and render gating intact; progress belongs in the tab.
        swap("import PreparationOverlay from '@/components/preparation/canvas/Overlay.vue'", '');
        remove(/        <PreparationOverlay\n[\s\S]*?        \/>\n/);
        swap('        data-test-id="canvas-area"', `        data-test-id="canvas-area"
        :inert="store.state.preparation !== null && store.state.preparation.kind !== 'font-retry'"`);
      } else if (file.endsWith('/src/app/shell/keyboard/use.ts')) {
        swap("import { useAIChat } from '@/app/ai/chat/use'", '');
        swap('  const { activeTab } = useAIChat()\n', '');
        swap('useEditorCommands, useViewportKind', 'useEditorCommands');
        swap('  const { isMobile } = useViewportKind()\n', '');
        swap('    activeTab,\n    isMobile,\n', '');
      } else if (file.endsWith('/src/app/shell/keyboard/actions.ts')) {
        swap("import type { Ref } from 'vue'", '');
        swap("import type { PropertiesTab } from '@/app/ai/chat/use'", '');
        swap('useEditorCommands, useViewportKind', 'useEditorCommands');
        swap("  activeTab: Ref<PropertiesTab>\n  isMobile: ReturnType<typeof useViewportKind>['isMobile']\n", '');
        swap('  activeTab,\n  isMobile,\n', '');
        remove(/  function toggleAI\(\) {[\s\S]*?\n  }\n/);
        swap('    toggleAI,\n', '');
      } else if (file.endsWith('/src/app/shell/keyboard/registry.ts')) {
        swap("    { id: 'toggle-ai', keys: '$mod+KeyJ', run: ({ actions }) => actions.toggleAI() },\n", '');
      } else if (file.endsWith('/src/app/shell/keyboard/types.ts')) {
        swap('  toggleAI: () => void\n', '');
      } else if (file.endsWith('/src/components/shell/AppMenu.vue')) {
        swap('<MenubarContent :side-offset="4"', '<MenubarContent :side-offset="8"');
        swap('<MenubarSubContent :side-offset="4"', '<MenubarSubContent :side-offset="8"');
        swap("import { templateRef } from '@vueuse/core'", "import controlStyles from '@cheshi/control-styles'");
        swap('class="flex cursor-pointer items-center rounded px-2 py-1 text-[11px] text-surface/80 transition-colors select-none hover:bg-hover hover:text-surface data-[state=open]:bg-hover data-[state=open]:text-surface"',
          ':class="controlStyles.control" class="cheshi-menu-trigger" data-variant="ghost"');
        swap("import { useTemplateRef, watch } from 'vue'", "import { useTemplateRef } from 'vue'");
        swap("import { useDocumentNameRename } from '@/app/shell/menu/document-name'", '');
        swap("import { resolvedAppTheme } from '@/app/shell/theme'", '');
        swap("import BrandMark from '@/components/brand/BrandMark.vue'", '');
        swap(`const { rename, editingName, startRename, commitRename } = useDocumentNameRename(store)\nconst nameInput = templateRef<HTMLInputElement>('nameInput')\n\nwatch(nameInput, (input) => {\n  if (input) void rename.focusInput(input)\n})`, '');
        const nameControls = result.match(/      <BrandMark[\s\S]*?(?=      <CloudDocumentStatusHost \/>)/)?.[0];
        if (!nameControls) throw new Error(`Missing document name controls in ${file}`);
        swap(nameControls, '');
        remove(/      <IconButton\n        :label="settings.title"[\s\S]*?<\/IconButton>\n/);
        remove(/      <IconButton\n        :label="`\$\{t.toggleUI\}[\s\S]*?<\/IconButton>\n/);
        swap("import { vTestId, useI18n } from '@open-pencil/vue'", "import { vTestId } from '@open-pencil/vue'");
        swap("import { useEditorStore } from '@/app/editor/active-store'", '');
        swap('const store = useEditorStore()', '');
        swap('const { menu: t, settings } = useI18n()', '');
        swap("import { openSettingsDialog } from '@/app/settings/dialog'", '');
        swap("import { appMenuShortcutLabel } from '@/app/shell/menu/shortcut'", '');
        swap("import IconButton from '@/components/ui/button/IconButton.vue'", '');
      }
      return result === source ? null : { code: result, map: null };
    },
  };
}
