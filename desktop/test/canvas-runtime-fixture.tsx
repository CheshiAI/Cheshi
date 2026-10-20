import { initializeOpenPencil, mountOpenPencil, type CanvasRuntime } from '../frontend/src/features/canvas/integration/sdk/openPencilRuntime';
import styles from './canvas-runtime-fixture.module.css';

declare global {
  interface Window { canvasFixture: { ready: boolean; error: string | null; runtime?: CanvasRuntime; changes: number; updates: number } }
}
window.canvasFixture = { ready: false, error: null, changes: 0, updates: 0 };
const state = window.canvasFixture;
document.getElementById('workspace')!.className = styles.body!;
document.getElementById('canvas')!.className = styles.canvas!;
try {
  await initializeOpenPencil();
  state.runtime = mountOpenPencil(document.getElementById('canvas')!, {
    active: () => true, onReady: () => { state.ready = true; }, onChange: () => { state.updates++; },
    onDirty: () => { state.changes++; }, onError: error => { state.error = String(error); },
  });
} catch (error) { state.error = String(error); }
