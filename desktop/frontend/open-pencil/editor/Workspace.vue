<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { useDocumentDrop } from '@/app/shell/document-drop';
import { useKeyboard } from '@/app/shell/keyboard/use';
import { useEditorMenu } from '@/app/shell/menu/use';
import { activeTab, allTabs, createHomeTab, createDocumentInCurrentTab } from '@/app/tabs';
import CommandPalette from '@/components/commands/CommandPalette.vue';
import RenameSelectionDialog from '@/components/selection/RenameSelectionDialog.vue';
import TabBar from '@/components/TabBar.vue';
import EditorWorkspace from './EditorWorkspace.vue';
import { connectHost } from './host';

if (!activeTab.value) createHomeTab();
// A new tab beside an open document creates a canvas; the last closed tab leaves the host's empty view.
watch(activeTab, tab => {
  if (tab?.kind === 'home' && allTabs.value.some(item => !item.isHome)) createDocumentInCurrentTab();
}, { flush: 'sync' });
useKeyboard();
useEditorMenu();
useDocumentDrop();
let disconnect: (() => void) | undefined;
onMounted(() => { disconnect = connectHost(); });
onUnmounted(() => disconnect?.());
</script>

<template>
  <main data-test-id="editor-root" class="cheshi-editor">
    <RenameSelectionDialog />
    <CommandPalette />
    <TabBar v-if="activeTab?.kind === 'document'" />
    <EditorWorkspace v-if="activeTab?.kind === 'document'" :key="activeTab.id" :tab="activeTab" />
  </main>
</template>
