<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@open-pencil/vue';
import { DEFAULT_TOOLBAR_LAYOUT } from '@/app/editor/toolbar/layout';
import { appPreferences, updateToolbarLayout } from '@/app/settings/preferences/store';
import ToolbarLayoutEditor from '@/components/settings/toolbar/ToolbarLayoutEditor.vue';
import CanvasRailButton from './CanvasRailButton.vue';
import inspectorStyles from '../../src/features/graph/GraphInspector.module.css';
import buttonStyles from '../../src/shared/ui/NeumorphicButton.module.css';

defineEmits<{ close: [] }>();
const { settings, common } = useI18n();
const layout = computed({
  get: () => appPreferences.value.toolbar,
  set: updateToolbarLayout,
});
function reset() {
  updateToolbarLayout(structuredClone(DEFAULT_TOOLBAR_LAYOUT));
}
</script>

<template>
  <section class="cheshi-toolbar-settings" :aria-label="settings.title" data-test-id="toolbar-settings-sidebar">
    <header :class="inspectorStyles.heading">
      <span>{{ settings.title }}</span>
      <div :class="inspectorStyles.headingActions">
        <button type="button" :class="[buttonStyles.control, 'cheshi-toolbar-reset']"
          data-variant="ghost" data-test-id="toolbar-settings-reset" @click="reset">
          {{ settings.toolbarReset }}
        </button>
        <CanvasRailButton :label="common.close" data-test-id="toolbar-settings-close" @click="$emit('close')">
          <icon-lucide-x aria-hidden="true" />
        </CanvasRailButton>
      </div>
    </header>
    <div class="cheshi-settings-body"><ToolbarLayoutEditor v-model="layout" /></div>
  </section>
</template>
