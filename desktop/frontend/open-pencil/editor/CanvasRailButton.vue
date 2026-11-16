<script setup lang="ts">
import Tip from '@/components/ui/overlay/Tip.vue';
import buttonStyles from '../../src/shared/ui/NeumorphicButton.module.css';

defineOptions({ inheritAttrs: false });
defineProps<{ label: string; expanded?: boolean; active?: boolean }>();
</script>

<template>
  <Tip :label="label" side="left" as-child>
    <button v-bind="$attrs" type="button" :class="buttonStyles.control"
      data-variant="ghost" data-size="icon" :data-active="active"
      :aria-label="label" :aria-expanded="expanded">
      <slot />
    </button>
  </Tip>
</template>
