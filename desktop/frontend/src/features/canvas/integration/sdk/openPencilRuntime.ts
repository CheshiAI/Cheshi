import { createApp, defineComponent, h, reactive, shallowRef } from 'vue';
import { createDefaultEditorState, createEditor, type Editor } from '@open-pencil/core/editor';
import { getCanvasKit } from '@open-pencil/core/canvaskit';
import { fontManager } from '@open-pencil/core/text';
import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig';
import { SceneGraph } from '@open-pencil/scene-graph';
import { provideEditor, useCanvas, useCanvasInput, useTextEdit } from '@open-pencil/vue';
import { installCanvasBackground } from './canvasBackground';
import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import regularUrl from '@open-pencil/core/assets/Inter-Regular.ttf?url';
import mediumUrl from '@open-pencil/core/assets/Inter-Medium.ttf?url';
import semiboldUrl from '@open-pencil/core/assets/Inter-SemiBold.ttf?url';
import boldUrl from '@open-pencil/core/assets/Inter-Bold.ttf?url';
import extraBoldUrl from '@open-pencil/core/assets/Inter-ExtraBold.ttf?url';
import arabicUrl from '@open-pencil/core/assets/NotoNaskhArabic-Regular.ttf?url';

const fonts: Record<string, string> = {
  'Inter-Regular.ttf': regularUrl, 'Inter-Medium.ttf': mediumUrl,
  'Inter-SemiBold.ttf': semiboldUrl, 'Inter-Bold.ttf': boldUrl,
  'Inter-ExtraBold.ttf': extraBoldUrl, 'NotoNaskhArabic-Regular.ttf': arabicUrl,
};
let initialization: Promise<void> | undefined;

export function initializeOpenPencil(): Promise<void> {
  initialization ??= (async () => {
    fontManager.setOnlineFontProviders({ google: false, fontsource: false, bunny: false, fontshare: false });
    fontManager.setBundledFontLocator(file => {
      const url = fonts[file];
      if (!url) throw new Error(`Bundled canvas font is unavailable: ${file}`);
      return url;
    });
    await getCanvasKit({ locateFile: () => wasmUrl });
    const response = await fetch(`${import.meta.env.BASE_URL}canvas-fonts/NanumGothic-Regular.ttf`);
    if (!response.ok) throw new Error('The bundled Korean font could not be loaded.');
    const font = await response.arrayBuffer();
    fontManager.markLoaded('Nanum Gothic', 'Regular', font, 'bundled');
    fontManager.registerFontInBrowser('Nanum Gothic', 'Regular', font);
    fontManager.setCJKFallbackFamily('Nanum Gothic');
    await fontManager.loadFont('Inter', 'Regular');
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}

export interface CanvasRuntime {
  editor: Editor;
  serialize(): Promise<Uint8Array>;
  open(data: Uint8Array): Promise<void>;
  fresh(): void;
  dispose(): void;
}

export function mountOpenPencil(host: HTMLElement, options: {
  active(): boolean;
  onReady(): void;
  onChange(): void;
  onDirty(): void;
  onError(error: unknown): void;
}): CanvasRuntime {
  const graph = new SceneGraph();
  const page = graph.getPages()[0];
  if (!page) throw new Error('OpenPencil did not create a page.');
  const editor = createEditor({ graph, state: reactive(createDefaultEditorState(page.id)),
    getViewportSize: () => ({ width: host.clientWidth, height: host.clientHeight }) });
  let disposed = false;
  let frame = 0;
  let backgroundRenderer: Editor['renderer'] = null;
  let restoreBackground: (() => void) | undefined;
  const notify = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => { frame = 0; options.onChange(); });
  };
  const unsubscribers = [
    editor.onEditorEvent('render:requested', notify),
    editor.onEditorEvent('selection:changed', notify),
    editor.onEditorEvent('tool:changed', notify),
    editor.onEditorEvent('page:changed', notify),
    editor.onEditorEvent('viewport:changed', notify),
    editor.onEditorEvent('history:changed', () => { options.onDirty(); notify(); }),
    editor.onEditorEvent('node:updated', (_id, changes) => {
      if (editor.state.editingTextId && 'text' in changes) options.onDirty();
    }),
  ];
  const surface = defineComponent({
    setup() {
      const canvas = shallowRef<HTMLCanvasElement | null>(null);
      provideEditor(editor);
      const rendering = useCanvas(canvas, editor, {
        showRulers: true, shouldSuspendRender: () => !options.active(),
        getRenderState: () => {
          if (editor.renderer && editor.renderer !== backgroundRenderer) {
            restoreBackground?.();
            backgroundRenderer = editor.renderer;
            restoreBackground = installCanvasBackground(editor.renderer);
          }
          return editor.state;
        },
        onReady: () => {
          if (disposed) return;
          if (!editor.renderer) { options.onError(new Error('Canvas requires WebGL graphics support.')); return; }
          options.onReady(); notify();
        },
      });
      useCanvasInput(canvas, editor, rendering.hitTestSectionTitle, rendering.hitTestComponentLabel,
        rendering.hitTestFrameTitle, undefined, () => canvas.value?.focus(), options.active);
      useTextEdit(canvas, editor, { isEnabled: options.active });
      return () => h('canvas', { ref: canvas, tabindex: 0, 'aria-label': 'Design canvas',
        onBlur: () => editor.setSelectedGuide(null),
        style: { width: 'var(--canvas-surface-width, 100%)', height: '100%', display: 'block', outline: 'none' } });
    },
  });
  const app = createApp(surface);
  app.config.errorHandler = options.onError;
  app.mount(host);
  // Sliding panels change the clipping area, while the drawing buffer stays
  // fixed. Refresh its presentation without resizing or moving the scene.
  const viewportObserver = new ResizeObserver(() => editor.requestRender());
  viewportObserver.observe(host);
  function replace(next: SceneGraph) {
    editor.commitTextEdit();
    editor.releaseGraphResources();
    editor.replaceGraph(next);
    editor.undo.clear();
    editor.setTool('SELECT');
    editor.zoomToFit();
    notify();
  }
  return {
    editor,
    async serialize() { editor.commitTextEdit(); return exportFigFile(editor.graph); },
    async open(data) {
      const next = await parseFigFile(new Uint8Array(data).buffer, { populate: 'all' });
      if (!disposed) replace(next);
    },
    fresh() { replace(new SceneGraph()); },
    dispose() {
      disposed = true;
      viewportObserver.disconnect();
      cancelAnimationFrame(frame);
      for (const unsubscribe of unsubscribers) unsubscribe();
      restoreBackground?.();
      app.unmount();
      editor.releaseGraphResources();
      editor.dispose();
    },
  };
}
