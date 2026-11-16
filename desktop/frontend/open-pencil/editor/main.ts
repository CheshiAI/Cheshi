import { createApp } from 'vue';
import { createHead } from '@unhead/vue/client';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createRetainedScopePlugin } from '@open-pencil/vue';
import App from '@/App.vue';
import Workspace from './Workspace.vue';
import { installBundledFonts } from '@/app/editor/fonts/bundled';
import { onlineFontsEnabled } from '@/app/editor/fonts';
import { getCanvasKit } from '@open-pencil/core/canvaskit';
import { fontManager } from '@open-pencil/core/text';
import './theme.css';

// A local editor must boot without downloading a font catalog. Users can opt in
// to providers in the original font settings when their environment permits it.
if (localStorage.getItem('cheshi:canvas-fonts-initialized') !== 'true') {
  onlineFontsEnabled.value = false;
  localStorage.setItem('cheshi:canvas-fonts-initialized', 'true');
}
installBundledFonts();
await getCanvasKit({ locateFile: file => new URL(`./${file}`, document.baseURI).href });
await fontManager.loadFont('Inter', 'Regular');
const koreanFont = await fetch(new URL('./NanumGothic-Regular.ttf', document.baseURI));
if (!koreanFont.ok) throw new Error('Bundled Korean font could not be loaded.');
const koreanBytes = await koreanFont.arrayBuffer();
fontManager.markLoaded('Nanum Gothic', 'Regular', koreanBytes, 'bundled');
fontManager.registerFontInBrowser('Nanum Gothic', 'Regular', koreanBytes);
fontManager.setCJKFallbackFamily('Nanum Gothic');
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/:pathMatch(.*)*', component: Workspace },
] });
const app = createApp(App);
app.use(createHead());
app.use(router);
app.use(createRetainedScopePlugin());
await router.push('/');
await router.isReady();
app.mount('#app');
