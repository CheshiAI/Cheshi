import { extractFromSource } from '../src/extraction';
import { detectLanguage, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerVueExtractionTests(): void {


  describe('Vue Extraction', () => {
    it('should detect Vue files', () => {
      expect(detectLanguage('App.vue')).toBe('vue');
      expect(detectLanguage('components/Button.vue')).toBe('vue');
      expect(isLanguageSupported('vue')).toBe(true);
    });

    it('should extract component node from a Vue SFC', () => {
      const code = /* language=TEXT */ `<template>
  <div>{{ message }}</div>
</template>

<script>
export default {
  data() {
    return { message: 'Hello' };
  }
}
</script>
`;
      const result = extractFromSource('HelloWorld.vue', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();
      expect(componentNode?.name).toBe('HelloWorld');
      expect(componentNode?.language).toBe('vue');
      expect(componentNode?.isExported).toBe(true);
    });

    it('should extract functions from a Vue script block', () => {
      const code = /* language=TEXT */ `<template>
  <button @click="handleClick">Click</button>
</template>

<script>
function handleClick() {
  console.log('clicked');
}

const count = 0;
</script>
`;
      const result = extractFromSource('Button.vue', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();
      expect(componentNode?.name).toBe('Button');

      const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'handleClick');
      expect(funcNode).toBeDefined();
      expect(funcNode?.language).toBe('vue');
    });

    it('should extract from a Vue script setup block', () => {
      const code = /* language=TEXT */ `<template>
  <div>{{ count }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);

function increment(): void {
  count.value++;
}
</script>
`;
      const result = extractFromSource('Counter.vue', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();
      expect(componentNode?.name).toBe('Counter');

      const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'increment');
      expect(funcNode).toBeDefined();
      expect(funcNode?.language).toBe('vue');

      // All nodes should be marked as vue language
      for (const node of result.nodes) {
        expect(node.language).toBe('vue');
      }
    });

    it('should extract calls from top-level script setup initializers', () => {
      const code = /* language=TEXT */ `<template>
  <div>{{ token }}</div>
</template>

<script setup lang="ts">
import { getTokenMp } from './api/upload';

const token = getTokenMp();
</script>
`;
      const result = extractFromSource('Issue425Setup.vue', code);

      const call = result.unresolvedReferences.find(
        (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'getTokenMp'
      );
      expect(call).toBeDefined();
    });

    it('should extract calls from Vue Options API object methods', () => {
      const code = /* language=TEXT */ `<template>
  <button @click="save">Save</button>
</template>

<script>
import { getTokenMp } from './api/upload';

export default {
  methods: {
    save() {
      return getTokenMp();
    }
  },
  setup() {
    return getTokenMp();
  }
}
</script>
`;
      const result = extractFromSource('Issue425Options.vue', code);

      const calls = result.unresolvedReferences.filter(
        (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'getTokenMp'
      );
      expect(calls).toHaveLength(2);
    });

    it('should extract component usages from the Vue template (PascalCase + kebab, skipping built-ins) (#629)', () => {
      const code = /* language=TEXT */ `<template>
  <div class="wrap">
    <UserCard :user="u" />
    <my-button>Click</my-button>
    <Transition><span>x</span></Transition>
  </div>
</template>

<script setup lang="ts">
import UserCard from './UserCard.vue';
import MyButton from './MyButton.vue';
</script>
`;
      const result = extractFromSource('Host.vue', code);
      const refs = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'references')
        .map((r) => r.referenceName);

      expect(refs).toContain('UserCard'); // PascalCase tag
      expect(refs).toContain('MyButton'); // kebab <my-button> → MyButton
      expect(refs).not.toContain('Transition'); // Vue built-in skipped
      expect(refs).not.toContain('Div'); // native HTML element skipped
      expect(refs).not.toContain('Span');
    });

    it('should extract from both Vue script block forms', () => {
      const code = /* language=TEXT */ `<template>
  <div>{{ msg }}</div>
</template>

<script>
export default {
  name: 'DualScript'
}
</script>

<script setup>
const msg = 'hello';

function greet() {
  return msg;
}
</script>
`;
      const result = extractFromSource('DualScript.vue', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();

      const greetFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
      expect(greetFunc).toBeDefined();
    });

    it('should create component node for template-only Vue file', () => {
      const code = /* language=TEXT */ `<template>
  <div>Static content</div>
</template>
`;
      const result = extractFromSource('Static.vue', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();
      expect(componentNode?.name).toBe('Static');
      expect(componentNode?.language).toBe('vue');

      // Only the component node should exist (no script nodes)
      expect(result.nodes.length).toBe(1);
    });

    it('should create containment edges from component to script nodes', () => {
      const code = /* language=TEXT */ `<template>
  <div>{{ value }}</div>
</template>

<script setup lang="ts">
const value = 42;
</script>
`;
      const result = extractFromSource('Contained.vue', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();

      // Should have containment edges from component to child nodes
      const containEdges = result.edges.filter(
        (e) => e.source === componentNode!.id && e.kind === 'contains'
      );
      expect(containEdges.length).toBeGreaterThan(0);
    });
  });
}
