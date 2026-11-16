<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanvasApi, CanvasRestoreRequest } from '../../../shared/canvas';
import { CanvasHistoryPanel } from '../../src/features/canvas/CanvasHistoryPanel';
import { hostStatus, requestHost } from './host';

const props = defineProps<{ path: string; active: boolean }>();
const emit = defineEmits<{ close: [] }>();
const element = ref<HTMLElement>();
let root: Root | undefined;
const api: Pick<CanvasApi, 'history' | 'readVersion'> = {
  history: path => requestHost('history', { path }),
  readVersion: (path, id) => requestHost('read-version', { path, id }),
};
const restore = (request: CanvasRestoreRequest) => requestHost<void>('restore-version', request);
const close = () => emit('close');
function render() {
  root?.render(createElement(CanvasHistoryPanel, {
    api, path: props.path, active: props.active, refresh: hostStatus.revision,
    disabled: hostStatus.busy || hostStatus.dirty, onRestore: restore, onClose: close,
  }));
}
onMounted(() => { root = createRoot(element.value!); render(); });
watch([() => props.path, () => props.active, () => hostStatus.revision, () => hostStatus.busy, () => hostStatus.dirty], render);
onBeforeUnmount(() => root?.unmount());
</script>

<template><div ref="element" class="cheshi-history-content" /></template>
