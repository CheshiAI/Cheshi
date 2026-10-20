import { mergeConfig } from 'vite';
import viteConfig from '../frontend/vite.config.ts';
import { openPencilOptimizedDependencies, openPencilWorkerSources } from './canvas-sdk-plugins.ts';
import { openPencilRulers } from '../frontend/open-pencil/rulers.ts';

/** Compatibility coverage for the published SDK; the app uses the original editor build. */
export default mergeConfig(viteConfig, {
  plugins: [openPencilWorkerSources(), openPencilRulers()],
  worker: { format: 'es', plugins: () => [openPencilWorkerSources()] },
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  optimizeDeps: {
    include: ['vue', ...openPencilOptimizedDependencies,
      '@open-pencil/dom-css/export', '@open-pencil/dom-css/scene-graph',
      '@open-pencil/fig/clipboard', '@open-pencil/fig/instance-overrides', '@open-pencil/fig/node-change',
      '@open-pencil/kiwi/fig', '@open-pencil/kiwi/fig/codec', '@open-pencil/kiwi/fig/guid',
      '@open-pencil/kiwi/fig/parse', '@open-pencil/kiwi/schema-runtime',
      'postcss-value-parser', 'source-map-js/lib/source-map-generator.js', 'cssesc'],
    exclude: ['@open-pencil/core', '@open-pencil/vue'],
  },
});
