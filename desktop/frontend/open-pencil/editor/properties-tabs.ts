import { computed, reactive } from 'vue';

export const canvasPanel = reactive<{
  panel: 'design' | 'lint' | 'settings' | 'history';
  panelOpen: boolean;
}>({ panel: 'design', panelOpen: false });

// Issue markers open the same Lint sidebar as its rail button, including when
// Lint was previously closed. Keep one mounted properties editor.
export const activePropertiesTab = computed<'design' | 'lint'>({
  get: () => canvasPanel.panel === 'lint' ? 'lint' : 'design',
  set: panel => { canvasPanel.panel = panel; canvasPanel.panelOpen = true; },
});
