import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import Icons from 'unplugin-icons/vite';
import IconsResolver from 'unplugin-icons/resolver';
import Components from 'unplugin-vue-components/vite';
import { createOpenPencilAliases } from '../../../vendor/open-pencil/vite/aliases';
import { aiIconCollection } from '../../../vendor/open-pencil/vite/icons';
import { rawMarkdownPlugin } from '../../../vendor/open-pencil/vite/raw-markdown';
import { bundledDependencyNotices } from './dependency-notices';
import { originalEditorAdaptations } from './source-adaptations';
import { browserEditorAdaptations } from './browser-adaptations';
import { editorBuildReport } from './build-report';
import { browserDependencies } from './browser-dependencies';
import { libraryChunk } from './chunks';

const here = dirname(fileURLToPath(import.meta.url));
const upstream = resolve(here, '../../../vendor/open-pencil');
const require = createRequire(import.meta.url);

export default defineConfig({
  root: resolve(here, 'editor'),
  base: './', publicDir: false,
  resolve: { alias: [
    { find: '@cheshi/control-styles', replacement: resolve(here, '../src/shared/ui/NeumorphicButton.module.css') },
    { find: '@cheshi/flat-tab-styles', replacement: resolve(here, '../src/shared/ui/FlatTab.module.css') },
    { find: '@cheshi/badge-styles', replacement: resolve(here, '../src/shared/ui/Badge.module.css') },
    { find: '@cheshi/switch-styles', replacement: resolve(here, '../src/shared/ui/ToggleSwitch.module.css') },
    { find: '@cheshi/text-field-styles', replacement: resolve(here, '../src/shared/ui/NeumorphicTextField.module.css') },
    { find: '@cheshi/panel-styles', replacement: resolve(here, '../src/shared/ui/LiquidGlassPanel.module.css') },
    { find: '@cheshi/CanvasTitleMark.vue', replacement: resolve(here, 'editor/CanvasTitleMark.vue') },
    { find: '@cheshi/properties-tabs', replacement: resolve(here, 'editor/properties-tabs.ts') },
    { find: /^@\/app\/collab\/transport$/, replacement: resolve(here, 'editor/local-collaboration.ts') },
    { find: /^@open-pencil\/mcp\/tools$/, replacement: resolve(upstream, 'packages/mcp/src/tool/index.ts') },
    { find: '#mcp', replacement: resolve(upstream, 'packages/mcp/src') },
    { find: /^@open-pencil\/feedback\/client$/, replacement: resolve(upstream, 'packages/feedback/src/client.ts') },
    { find: /^@open-pencil\/feedback\/contract$/, replacement: resolve(upstream, 'packages/feedback/src/contract/index.ts') },
    { find: '#feedback', replacement: resolve(upstream, 'packages/feedback/src') },
    { find: /^@\/app\/document\/io\/save\/actions$/, replacement: resolve(here, 'editor/save.ts') },
    { find: /^@\/app\/document\/close\/prompt$/, replacement: resolve(here, 'editor/close-prompt.ts') },
    { find: /^opentype\.js$/, replacement: require.resolve('opentype.js').replace(/opentype\.js$/, 'opentype.mjs') },
    ...createOpenPencilAliases(upstream, { cloud: false }),
  ], dedupe: ['vue'] },
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    __OPENPENCIL_APP_VERSION__: JSON.stringify('0.16.0'),
    __OPENPENCIL_LOCAL_AUTOMATION_TOKEN__: JSON.stringify(''),
    __OPENPENCIL_LOCAL_AUTOMATION_URL__: JSON.stringify(''),
    __OPENPENCIL_LOCAL_AUTOMATION_HTTP_URL__: JSON.stringify(''),
  },
  plugins: [
    browserDependencies(), originalEditorAdaptations(), browserEditorAdaptations(), rawMarkdownPlugin(), tailwindcss(),
    Icons({ compiler: 'vue3', customCollections: { ai: aiIconCollection() } }),
    Components({ dirs: [resolve(upstream, 'src/components')],
      globsExclude: [resolve(upstream, 'src/components/**/examples/**')],
      dts: false, resolvers: [IconsResolver({ prefix: 'icon', customCollections: ['ai'] })] }),
    vue(), bundledDependencyNotices(), editorBuildReport(),
    { name: 'cheshi-editor-runtime-assets', generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'canvaskit.wasm', source: readFileSync(require.resolve('canvaskit-wasm/bin/canvaskit.wasm')) });
      this.emitFile({ type: 'asset', fileName: 'open-pencil-LICENSE.txt', source: readFileSync(resolve(upstream, 'LICENSE')) });
      this.emitFile({ type: 'asset', fileName: 'brand/mark.svg', source: readFileSync(resolve(upstream, 'assets/brand/mark.svg')) });
      this.emitFile({ type: 'asset', fileName: 'NanumGothic-Regular.ttf', source: readFileSync(resolve(here, '../public/canvas-fonts/NanumGothic-Regular.ttf')) });
    } },
  ],
  worker: { format: 'es' },
  build: { target: 'esnext', outDir: resolve(here, '../public/open-pencil'), emptyOutDir: true,
    manifest: true, chunkSizeWarningLimit: 3000,
    rollupOptions: { output: { manualChunks: libraryChunk } } },
});
