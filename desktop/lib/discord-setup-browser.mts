import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { BrowserWindow, BrowserWindowConstructorOptions, Clipboard } from 'electron';
import { discordId, discordPreferences, discordRecord, type DiscordPreferences, type DiscordSettings } from '../shared/discord.ts';
import { discordSetupPage } from './discord-setup-page.mts';
import type { DiscordSetupBrowser } from './discord-setup-tools.mts';

export interface DiscordSetupSettings {
  get(): DiscordSettings;
  save(value: unknown): Promise<DiscordSettings>;
}
const permissions = '68624'; // Manage Channels | View Channel | Send Messages | Read Message History
export function allowedDiscordSetupUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://discord.com' && !url.username && !url.password &&
      /^\/(?:developers\/applications(?:\/.*)?|channels(?:\/.*)?|app|login|register|verify(?:\/.*)?|reset(?:\/.*)?|mfa(?:\/.*)?|oauth2\/authorize)\/?$/.test(url.pathname);
  } catch { return false; }
}
export function discordSetupDestination(input: Record<string, unknown>): string {
  switch (input.target) {
    case 'portal': return 'https://discord.com/developers/applications';
    case 'discord': return 'https://discord.com/channels/@me';
    case 'application': return `https://discord.com/developers/applications/${discordId(input.applicationId)}/information`;
    case 'bot': return `https://discord.com/developers/applications/${discordId(input.applicationId)}/bot`;
    case 'server': return `https://discord.com/channels/${discordId(input.guildId)}`;
    case 'install': return `https://discord.com/oauth2/authorize?client_id=${discordId(input.applicationId)}&scope=bot&permissions=${permissions}`;
    default: throw new Error('Choose a supported setup destination.');
  }
}

export function createDiscordSetupBrowser(options: {
  parent: BrowserWindow;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  clipboard: Pick<Clipboard, 'readText' | 'writeText'>;
  confirm(preferences: DiscordPreferences, signal: AbortSignal): Promise<boolean>;
  settings: DiscordSetupSettings;
}): DiscordSetupBrowser {
  let window: BrowserWindow | null = null, disposed = false;
  const lifetime = new AbortController();
  const partition = `cheshi-discord-setup-${randomUUID()}`;
  let revision = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const assertActive = () => { if (disposed || options.parent.isDestroyed()) throw new Error('Setup has closed.'); };
  const status = (text: string) => { if (window && !window.isDestroyed()) window.setTitle(`Discord Setup — ${text}`); };
  async function open() {
    assertActive();
    if (window && !window.isDestroyed()) { window.show(); return window; }
    const created = options.createWindow({ width: 1060, height: 780, minWidth: 700, minHeight: 500,
      parent: options.parent, title: 'Discord Setup', autoHideMenuBar: true, backgroundColor: '#1e1f22',
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false } });
    window = created;
    created.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(permission === 'clipboard-sanitized-write' && allowedDiscordSetupUrl(details.requestingUrl));
    });
    created.webContents.session.setPermissionCheckHandler((_contents, permission, origin) => permission === 'clipboard-sanitized-write' && origin === 'https://discord.com');
    created.webContents.session.on('will-download', event => event.preventDefault());
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guardNavigation = (event: { preventDefault(): void }, url: string) => { if (!allowedDiscordSetupUrl(url)) event.preventDefault(); };
    created.webContents.on('will-navigate', guardNavigation);
    created.webContents.on('will-redirect', guardNavigation);
    created.webContents.on('will-attach-webview', event => event.preventDefault());
    created.webContents.on('page-title-updated', event => event.preventDefault());
    created.on('closed', () => { revision++; if (window === created) window = null; });
    await created.loadURL('https://discord.com/developers/applications');
    assertActive(); status('Ready'); return created;
  }
  const close = () => {
    if (disposed) return;
    disposed = true; revision++;
    lifetime.abort();
    options.parent.removeListener('closed', close);
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  };
  options.parent.once('closed', close);
  async function execute(value: unknown): Promise<unknown> {
    assertActive();
    const input = discordRecord(value);
    const fields = new Set(['action', 'target', 'applicationId', 'guildId', 'ownerId', 'deviceName', 'ref', 'text', 'direction']);
    if (Object.keys(input).some(key => !fields.has(key))) throw new Error('Unsupported setup argument.');
    const action = input.action;
    if (action === 'settings') return { ...options.settings.get(), suggestedDeviceName: hostname().slice(0, 60) };
    if (action === 'finish') { close(); return { status: 'Setup window closed.' }; }
    if (action === 'configure') {
      const preferences = discordPreferences({ enabled: false, guildId: input.guildId, ownerId: input.ownerId, deviceName: input.deviceName });
      const previous = options.settings.get();
      if (previous.enabled) return { status: 'user-action-required', reason: 'An existing connection is enabled. Edit or disable it in Settings before replacing it.' };
      const setupWindow = window;
      if (setupWindow && !setupWindow.isDestroyed()) setupWindow.hide();
      let decision: boolean;
      try { decision = await options.confirm(preferences, lifetime.signal); }
      finally { if (!disposed && setupWindow && !setupWindow.isDestroyed()) setupWindow.show(); }
      assertActive();
      if (decision !== true) return { status: 'cancelled' };
      if (JSON.stringify(options.settings.get()) !== JSON.stringify(previous)) return { status: 'Settings changed. Inspect them before continuing.' };
      // No token parameter exists in the model-facing tool. Preserve a previously saved token.
      return options.settings.save(preferences);
    }
    if (action === 'connect') {
      const current = options.settings.get();
      if (!current.hasToken) return { status: 'user-action-required', reason: 'Enter your bot token directly in Cheshi Settings → Notifications → Discord and save. Never paste it in chat.' };
      if (current.enabled) return current;
      return options.settings.save({ enabled: true, guildId: current.guildId, ownerId: current.ownerId, deviceName: current.deviceName });
    }
    if (!['inspect', 'navigate', 'click', 'context_menu', 'fill', 'scroll', 'copy_id'].includes(String(action))) throw new Error('Unsupported setup action.');
    if (action === 'navigate') {
      const idField = input.target === 'server' ? 'guildId' : ['application', 'bot', 'install'].includes(String(input.target)) ? 'applicationId' : null;
      if (idField && (typeof input[idField] !== 'string' || !/^[0-9]{17,20}$/.test(input[idField]))) {
        return { status: 'invalid-argument', reason: `This destination requires a numeric ${idField}. Use target discord to create or select a server; target server opens an existing server by ID.` };
      }
      const destination = discordSetupDestination(input);
      const view = await open(); status('Opening page');
      await view.loadURL(destination); return { status: 'Page opened. Inspect before acting.' };
    }
    const view = await open();
    if (!allowedDiscordSetupUrl(view.webContents.getURL())) throw new Error('Setup is outside Discord.');
    const currentRevision = revision;
    const safeInput = { action: String(action), ref: typeof input.ref === 'string' ? input.ref : undefined,
      text: typeof input.text === 'string' ? input.text : undefined, direction: typeof input.direction === 'string' ? input.direction : undefined };
    // Isolation keeps element references separate from Discord's own JavaScript.
    const code = `(${discordSetupPage.toString()})(${JSON.stringify(safeInput)})`;
    const previousClipboard = action === 'copy_id' ? options.clipboard.readText() : '';
    const sentinel = `cheshi-setup-${randomUUID()}`;
    if (action === 'copy_id') options.clipboard.writeText(sentinel);
    try {
      const result = await view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }], true) as { status?: string };
      assertActive();
      if (revision !== currentRevision) throw new Error('Setup window changed.');
      if (action === 'copy_id' && result.status === 'action-performed') {
        await new Promise(resolve => setTimeout(resolve, 100));
        const copied = options.clipboard.readText();
        if (!/^[0-9]{17,20}$/.test(copied)) return { status: 'No numeric Discord ID was copied. Inspect and select Copy Server ID or Copy User ID.' };
        return { id: copied };
      }
      status(result.status === 'user-action-required' ? 'Waiting for you' : 'Assistant working');
      // URLs are returned without query parameters, which can contain OAuth data.
      return { ...result, page: new URL(view.webContents.getURL()).pathname };
    } finally {
      if (action === 'copy_id') {
        const current = options.clipboard.readText();
        if (current === sentinel || /^[0-9]{17,20}$/.test(current)) options.clipboard.writeText(previousClipboard);
      }
    }
  }
  return { close, execute(value) {
    const task = queue.then(() => execute(value)); queue = task.catch(() => {}); return task;
  } };
}
