import { WebContentsView } from 'electron';
import type { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { WORKSPACE_HOST_CHANNEL as channel } from '../shared/workspace-host.ts';
import type { WorkspaceRailOverlay } from '../shared/workspace-host.ts';

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Cheshi Rail Overlay</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;background:transparent;overflow:hidden;cursor:pointer;user-select:none}
#button{position:absolute;top:0;overflow:hidden;box-sizing:border-box}
#label{position:absolute;top:0;height:100%;display:flex;align-items:center;white-space:nowrap}</style>
</head><body><div id="button"><span id="label"></span></div></body></html>`;

function validOverlay(value: unknown): value is WorkspaceRailOverlay {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return ['id', 'label', 'font', 'color', 'background', 'radius'].every(key => typeof data[key] === 'string' && data[key].length <= 512)
    && ['x', 'y', 'width', 'height', 'clipLeft', 'labelLeft'].every(key => typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0)
    && (data.width as number) <= 640 && (data.height as number) <= 128;
}

/** A narrow, input-aware continuation of a rail button, above all workspace views. */
export class WorkspaceRailOverlayLayer {
  private readonly host: BrowserWindow;
  private readonly view: WebContentsView;
  private current: WorkspaceRailOverlay | null = null;
  private ready = false;
  private disposed = false;
  private rendering = false;
  private revision = 0;
  private pressed = false;
  private readonly onRegion: (region: WorkspaceRailOverlay | null) => void;
  private readonly dismiss = () => this.hide(true);

  constructor(host: BrowserWindow, onRegion: (region: WorkspaceRailOverlay | null) => void) {
    this.host = host;
    this.onRegion = onRegion;
    this.view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    this.view.setBackgroundColor('#00000000');
    this.view.setVisible(false);
    host.contentView.addChildView(this.view);
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.view.webContents.on('will-navigate', event => event.preventDefault());
    this.view.webContents.on('before-mouse-event', (_event, mouse) => {
      if (!this.current) return;
      if (mouse.type === 'mouseLeave') {
        // The source button continues immediately to the left of this view.
        if (!(mouse.x <= 0 && mouse.y >= 0 && mouse.y < this.current.height)) this.hide(true);
      } else if (mouse.type === 'mouseDown' && mouse.button === 'left') this.pressed = true;
      else if (mouse.type === 'mouseUp' && mouse.button === 'left' && this.pressed) {
        host.webContents.send(`${channel}:rail-event`, { id: this.current.id, action: 'activate' });
        this.hide(false);
        host.webContents.focus();
      }
    });
    const events: EventEmitter = host;
    for (const event of ['blur', 'resize', 'hide']) events.on(event, this.dismiss);
    void this.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).then(() => {
      if (this.disposed) return;
      this.ready = true;
      void this.render();
    }).catch(error => {
      if (!this.disposed) process.stderr.write(`[cheshi] Rail overlay failed: ${String(error)}\n`);
    });
  }

  update(value: unknown, railEdge: number): void {
    if (value === null) { this.hide(false); return; }
    if (!validOverlay(value) || Math.abs(value.clipLeft * this.host.webContents.getZoomFactor() - railEdge) > 2) return;
    this.current = value;
    this.revision++;
    void this.render();
  }

  hide(notify = true): void {
    const previous = this.current;
    this.current = null; this.pressed = false; this.revision++;
    if (this.disposed) return;
    this.view.setVisible(false);
    this.onRegion(null);
    if (notify && previous && !this.host.isDestroyed()) this.host.webContents.send(`${channel}:rail-event`, { id: previous.id, action: 'dismiss' });
  }

  private async render(): Promise<void> {
    if (!this.ready || this.disposed || this.rendering) return;
    this.rendering = true;
    try {
      while (this.current && !this.disposed) {
        const data = this.current, version = this.revision;
        const zoom = this.host.webContents.getZoomFactor();
        const left = Math.round(data.clipLeft * zoom), top = Math.round(data.y * zoom);
        const bounds = this.host.getContentBounds();
        const width = Math.max(0, Math.min(bounds.width, Math.ceil((data.x + data.width) * zoom)) - left);
        const height = Math.max(0, Math.min(bounds.height - top, Math.ceil(data.height * zoom)));
        if (!width || !height) { this.view.setVisible(false); this.onRegion(null); break; }
        this.view.webContents.setZoomFactor(zoom);
        await this.view.webContents.executeJavaScript(`(() => {
          const data = ${JSON.stringify(data)}, button = document.getElementById('button'), label = document.getElementById('label');
          Object.assign(button.style, {left:(data.x-${left / zoom})+'px',width:data.width+'px',height:data.height+'px',
            background:data.background,borderRadius:data.radius,color:data.color,font:data.font});
          label.style.left=data.labelLeft+'px'; label.textContent=data.label;
        })()`);
        if (this.disposed || version !== this.revision) continue;
        this.view.setBounds({ x: left, y: top, width, height });
        if (this.host.contentView.children.at(-1) !== this.view) this.host.contentView.addChildView(this.view);
        this.view.setVisible(true);
        this.onRegion(data);
        break;
      }
    } catch (error) {
      if (!this.disposed) { this.hide(true); process.stderr.write(`[cheshi] Rail overlay render failed: ${String(error)}\n`); }
    } finally { this.rendering = false; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true;
    const events: EventEmitter = this.host;
    for (const event of ['blur', 'resize', 'hide']) events.off(event, this.dismiss);
    if (!this.host.isDestroyed()) this.host.contentView.removeChildView(this.view);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false });
  }
}
