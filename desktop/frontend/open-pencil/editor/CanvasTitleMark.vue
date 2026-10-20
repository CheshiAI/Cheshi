<template>
  <span class="canvas-tab-icon" data-test-id="canvas-tab-icon" aria-hidden="true">
    <icon-lucide-frame />
  </span>
</template>

<style scoped>
.canvas-tab-icon {
  display: inline-flex;
  width: var(--tab-icon-size);
  height: var(--tab-icon-size);
  flex: 0 0 var(--tab-icon-size);
  color: inherit;
}
.canvas-tab-icon > svg {
  width: 100%;
  height: 100%;
  stroke-width: var(--tab-icon-stroke-width);
}
</style>
