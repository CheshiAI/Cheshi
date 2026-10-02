import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { GhosttySurfaceHost } from '../ghostty-surface-host.mts';
import type { AgentEngine } from './engine.mts';
import { parseAgentEngineId, parseAgentId } from '../../shared/agent-management.ts';
import { AGENT_TERMINAL_CHANNELS, parseAgentTerminalBounds } from '../../shared/agent-terminal.ts';
import type { AgentTerminalSession } from '../../shared/agent-terminal.ts';

type Host = Pick<GhosttySurfaceHost, 'available' | 'sync' | 'updatePane' | 'setDark' | 'setWindowVisible' | 'close'>;
type Entry = { session: AgentTerminalSession; host: Host };

/** Window-owned shells; the renderer supplies identity and geometry, never a host command. */
export class AgentTerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly window: BrowserWindow;
  private readonly engines: AgentEngine[];
  private readonly workingDirectory: string;
  private readonly createHost: (options: ConstructorParameters<typeof GhosttySurfaceHost>[0]) => Host;
  private disposed = false;
  private pending = 0;
  private generation = 0;
  constructor(options: { window: BrowserWindow; engines: AgentEngine[]; workingDirectory: string;
    createHost?: (options: ConstructorParameters<typeof GhosttySurfaceHost>[0]) => Host }) {
    this.window = options.window;
    this.engines = options.engines;
    this.workingDirectory = options.workingDirectory;
    this.createHost = options.createHost ?? (value => new GhosttySurfaceHost(value));
    this.window.on('show', this.syncVisibility);
    this.window.on('hide', this.syncVisibility);
    this.window.on('minimize', this.syncVisibility);
    this.window.on('restore', this.syncVisibility);
    this.window.webContents.on('did-start-navigation', this.navigation);
  }
  private syncVisibility = () => {
    for (const { host } of this.entries.values()) host.setWindowVisible(this.window.isVisible() && !this.window.isMinimized());
  };
  private navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!inPlace && mainFrame) { this.generation++; for (const id of this.entries.keys()) void this.close(id); }
  };
  private end(id: string, error: string | null) {
    const entry = this.entries.get(id);
    if (!entry || entry.session.ended) return;
    entry.session = { ...entry.session, ended: true, error };
    entry.host.close();
    if (!this.window.webContents.isDestroyed()) this.window.webContents.send(AGENT_TERMINAL_CHANNELS.changed, entry.session);
  }
  async open(input: string, agentInput: string): Promise<AgentTerminalSession> {
    if (this.disposed || this.entries.size + this.pending >= 8) throw new Error('Container terminal is unavailable.');
    const engineId = parseAgentEngineId(input), agentId = parseAgentId(agentInput);
    const engine = this.engines.find(item => item.kind === engineId.split(':')[0]);
    if (!engine?.terminalCommand) throw new Error('This engine does not support an interactive terminal.');
    this.pending++;
    const generation = this.generation;
    try {
      const command = await engine.terminalCommand(engineId, agentId);
      if (this.disposed || this.window.isDestroyed() || generation !== this.generation) throw new Error('Workspace was closed or reloaded.');
      const id = randomUUID();
      const host = this.createHost({ owner: this.window, workingDirectory: this.workingDirectory, command, dark: true,
        onClose: () => this.end(id, null), onError: error => this.end(id, error.message) });
      if (!host.available) { host.close(); throw new Error('Container terminals require the macOS Ghostty runtime.'); }
      const session = { id, engineId, agentId, ended: false, error: null };
      this.entries.set(id, { host, session });
      this.syncVisibility();
      return session;
    } finally { this.pending--; }
  }
  async update(input: unknown): Promise<void> {
    const value = parseAgentTerminalBounds(input), entry = this.entries.get(value.id);
    if (!entry || entry.session.ended || this.disposed) return;
    const zoom = this.window.webContents.getZoomFactor();
    const bounds = this.window.getContentBounds();
    const frame = { x: value.x / zoom, y: value.y / zoom, width: value.width / zoom, height: value.height / zoom };
    const visible = value.visible && frame.x >= 0 && frame.y >= 0
      && frame.x + frame.width <= bounds.width + 1 && frame.y + frame.height <= bounds.height + 1;
    entry.host.setDark(value.dark);
    entry.host.sync({ paneIds: [value.id], visiblePaneIds: visible ? [value.id] : [],
      activePaneId: visible ? value.id : null, pageVisible: visible });
    entry.host.updatePane(value.id, frame, visible);
  }
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    entry?.host.close();
  }
  dispose() {
    this.disposed = true;
    this.window.off('show', this.syncVisibility);
    this.window.off('hide', this.syncVisibility);
    this.window.off('minimize', this.syncVisibility);
    this.window.off('restore', this.syncVisibility);
    this.window.webContents.off('did-start-navigation', this.navigation);
    for (const id of this.entries.keys()) void this.close(id);
  }
}
