<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, toRefs, watch } from 'vue';
import { useDesignCheckMessages, useI18n } from '@open-pencil/vue';
import { provideTabEditorStore } from '@/app/editor/active-store';
import type { Tab } from '@/app/tabs';
import CanvasSplitRoot from '@/components/canvas/CanvasSplitRoot.vue';
import LayersPanel from '@/components/LayersPanel.vue';
import PropertiesPanel from '@/components/PropertiesPanel.vue';
import DesignCheckRulesMenu from '@/components/design-check/DesignCheckRulesMenu.vue';
import Toolbar from '@/components/toolbar/Toolbar.vue';
import VariablesDialog from '@/components/variables/VariablesDialog.vue';
import StatusesDialog from '@/components/statuses/StatusesDialog.vue';
import CommentDeleteDialog from '@/components/comments/CommentDeleteDialog.vue';
import AppMenu from '@/components/shell/AppMenu.vue';
import { settingsDialogOpen } from '@/app/settings/dialog';
import CanvasRailButton from './CanvasRailButton.vue';
import ToolbarSettingsSidebar from './ToolbarSettingsSidebar.vue';
import { canvasPanel } from './properties-tabs';
import { hostLayout } from './host';
import ZoomDropdown from '@/components/editor/ZoomDropdown.vue';
import { connectCanvasBlur } from './canvasBlur';
import inspectorStyles from '../../src/features/graph/GraphInspector.module.css';
import panelStyles from '../../src/shared/ui/LiquidGlassPanel.module.css';

const { tab } = defineProps<{ tab: Tab }>();
const store = tab.store;
provideTabEditorStore(store);
const { common, panels } = useI18n();
const layersStyle = computed(() => {
  const rect = hostLayout.value?.layers;
  return rect ? { position: 'fixed' as const, left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` } : undefined;
});
const checkMessages = useDesignCheckMessages();
type Panel = typeof canvasPanel.panel;
const { panel, panelOpen } = toRefs(canvasPanel);
const CanvasHistoryPanel = defineAsyncComponent(() => import('./CanvasHistoryPanel.vue'));
const historyVisited = ref(false);
watch(panel, value => { if (value === 'history') historyVisited.value = true; }, { immediate: true });
const panelRail = ref<HTMLElement>();
const settingsPage = ref<HTMLElement>();
const canvasScene = ref<HTMLElement>();
const scenePreparing = ref(true);
let sceneRevealFrame = 0;
watch(() => store.state.preparation !== null && store.state.preparation.kind !== 'font-retry', preparing => {
  cancelAnimationFrame(sceneRevealFrame);
  if (preparing) {
    scenePreparing.value = true;
    return;
  }
  if (!scenePreparing.value) return;
  // Fit runs at the end of preparation. Let the canvas paint that view before
  // revealing it, without changing the viewport's measurable dimensions.
  sceneRevealFrame = requestAnimationFrame(() => {
    sceneRevealFrame = requestAnimationFrame(() => {
      sceneRevealFrame = 0;
      scenePreparing.value = false;
    });
  });
}, { immediate: true });
let disconnectBlur: (() => void) | undefined;
let viewportObserver: ResizeObserver | undefined;
let viewportFrame = 0;
const invalidViewport = () => !(Number.isFinite(store.state.zoom) && store.state.zoom > 0
  && Number.isFinite(store.state.panX) && Number.isFinite(store.state.panY));
function recoverViewport() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    // CanvasSplitRoot updates the store size in its own resize frame. Wait
    // until that frame has finished before using the dimensions to fit.
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      const scene = canvasScene.value;
      const size = store.getViewportSize();
      if (!scene || scene.clientWidth <= 0 || scene.clientHeight <= 0
        || size.width <= 0 || size.height <= 0 || store.state.preparation !== null || !invalidViewport()) return;
      // Repair only an invalid presentation transform; preserve normal pan/zoom.
      // An empty page still needs a usable transform when zoomToFit is a no-op.
      store.state.zoom = 1;
      store.state.panX = 0;
      store.state.panY = 0;
      store.zoomToFit();
      store.requestRender();
    });
  });
}
watch(() => store.state.preparation === null && invalidViewport(), invalid => { if (invalid) recoverViewport(); });
onMounted(() => {
  if (!canvasScene.value) return;
  disconnectBlur = connectCanvasBlur(canvasScene.value);
  viewportObserver = new ResizeObserver(recoverViewport);
  viewportObserver.observe(canvasScene.value);
  recoverViewport();
});
onBeforeUnmount(() => {
  cancelAnimationFrame(sceneRevealFrame);
  disconnectBlur?.();
  viewportObserver?.disconnect();
  cancelAnimationFrame(viewportFrame);
});
const previewing = computed(() => store.state.play !== null);
// The upstream menu, keyboard shortcut and toolbar context menu share this request.
watch(settingsDialogOpen, open => {
  if (open) {
    panel.value = 'settings';
    panelOpen.value = true;
    store.state.showUI = true;
    void nextTick(() => {
      if (panelOpen.value && panel.value === 'settings') {
        settingsPage.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
      }
    });
  } else if (panelOpen.value && panel.value === 'settings') closePanel();
}, { immediate: true });
onBeforeUnmount(() => { settingsDialogOpen.value = false; });
function closePanel() {
  panelRail.value?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
  panelOpen.value = false;
  settingsDialogOpen.value = false;
}
function toggle(next: Panel) {
  if (panelOpen.value && panel.value === next) { closePanel(); return; }
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  panel.value = next;
  panelOpen.value = true;
  settingsDialogOpen.value = next === 'settings';
}
</script>

<template>
  <div class="cheshi-workspace">
    <div v-show="store.state.showUI && !previewing" class="cheshi-menu"><AppMenu /></div>
    <div class="cheshi-stage">
      <Teleport to="body" :disabled="!hostLayout.value">
        <section v-show="store.state.showUI && !previewing && (!hostLayout.value || hostLayout.value.layers)"
          class="cheshi-panel-page cheshi-docked-layers" :style="layersStyle" aria-label="Pages and layers">
          <header :class="inspectorStyles.heading" data-test-id="canvas-file-heading"><span>Pages and layers</span></header>
          <LayersPanel />
        </section>
      </Teleport>
      <div class="cheshi-canvas">
        <div ref="canvasScene" class="cheshi-canvas-scene" :data-preparing="scenePreparing"><CanvasSplitRoot /></div>
        <Toolbar v-show="store.state.showUI && !previewing" />
        <button v-if="previewing" class="cheshi-preview-exit" @click="store.stopPlay()">Exit preview</button>
        <button v-else-if="!store.state.showUI" class="cheshi-preview-exit" @click="store.state.showUI = true">Show interface</button>
      </div>
      <aside v-show="store.state.showUI && !previewing" :class="['cheshi-panels', inspectorStyles.inspector]" :data-open="panelOpen">
        <div :class="['cheshi-panel-stage', inspectorStyles.stage]" :data-open="panelOpen">
          <div :class="['cheshi-panel-content', inspectorStyles.panel, panelStyles.panel]"
            :aria-hidden="!panelOpen || undefined" :inert="!panelOpen" @keydown.esc.stop="closePanel">
            <section v-show="panel === 'design' || panel === 'lint'" :class="['cheshi-panel-page', inspectorStyles.content]"
              :aria-label="panel === 'lint' ? checkMessages.tab : panels.design">
              <header :class="inspectorStyles.heading" :data-test-id="panel === 'lint' ? 'canvas-lint-heading' : 'canvas-design-heading'">
                <span>{{ panel === 'lint' ? checkMessages.tab : panels.design }}</span>
                <div :class="inspectorStyles.headingActions">
                  <ZoomDropdown v-show="panel === 'design'" />
                  <DesignCheckRulesMenu v-if="panel === 'lint'" />
                  <CanvasRailButton :label="common.close" data-test-id="canvas-properties-close" @click="closePanel">
                    <icon-lucide-x aria-hidden="true" />
                  </CanvasRailButton>
                </div>
              </header>
              <PropertiesPanel />
            </section>
            <div v-show="panel === 'settings'" ref="settingsPage" class="cheshi-panel-page">
              <ToolbarSettingsSidebar @close="closePanel" />
            </div>
            <div v-show="panel === 'history'" class="cheshi-panel-page">
              <CanvasHistoryPanel v-if="historyVisited" :path="store.getDocumentFilePath() ?? ''" :active="panelOpen && panel === 'history'" @close="closePanel" />
            </div>
          </div>
        </div>
        <nav ref="panelRail" :class="['cheshi-panel-rail', inspectorStyles.rail]" aria-label="Canvas panel controls">
          <CanvasRailButton label="Toolbar settings" :expanded="panelOpen && panel === 'settings'"
            data-test-id="app-settings-trigger" @click="toggle('settings')">
            <icon-lucide-settings aria-hidden="true" />
          </CanvasRailButton>
          <CanvasRailButton :label="panels.design" data-test-id="canvas-design-trigger" :expanded="panelOpen && panel === 'design'" @click="toggle('design')">
            <icon-lucide-pencil-ruler aria-hidden="true" />
          </CanvasRailButton>
          <CanvasRailButton :label="checkMessages.tab" data-test-id="canvas-lint-trigger" :expanded="panelOpen && panel === 'lint'" @click="toggle('lint')">
            <icon-lucide-list-checks aria-hidden="true" />
          </CanvasRailButton>
          <CanvasRailButton label="Version history" :expanded="panelOpen && panel === 'history'" @click="toggle('history')">
            <icon-lucide-history aria-hidden="true" />
          </CanvasRailButton>
          <CanvasRailButton label="Preview" @click="store.startPlay()">
            <icon-lucide-play aria-hidden="true" />
          </CanvasRailButton>
        </nav>
      </aside>
    </div>
    <VariablesDialog />
    <StatusesDialog />
    <CommentDeleteDialog />
  </div>
</template>
