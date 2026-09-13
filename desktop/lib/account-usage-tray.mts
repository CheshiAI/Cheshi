import type { BrowserWindow, Menu, MenuItemConstructorOptions, NativeImage, NativeTheme, Tray, nativeImage } from 'electron';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';
import { accountUsageTotals } from '../shared/codex-account-usage.ts';
import { isLowAccountUsage, renderAccountUsageTrayIcon } from './account-usage-tray-icon.mts';
import type { MenuBarFont } from './menu-bar-font.mts';
import type { MenuBarLogo } from './menu-bar-logo.mts';

type TrayHandle = Pick<Tray, 'setImage' | 'setToolTip' | 'setContextMenu' | 'destroy'>;
type UsageWindow = Pick<BrowserWindow, 'isDestroyed' | 'isFocused' | 'isMinimized' | 'restore' | 'show' | 'focus' | 'on' | 'off'>;
interface UsageSource {
  snapshot: CodexAccountsSnapshot | null;
  window: UsageWindow | null;
  detach(): void;
}

/** One menu-bar item for the application; sources belong to individual workspace windows. */
export function createAccountUsageTray(options: {
  createTray(image: NativeImage): TrayHandle;
  createMenu(template: MenuItemConstructorOptions[]): Menu;
  images: Pick<typeof nativeImage, 'createEmpty'>;
  theme: Pick<NativeTheme, 'shouldUseDarkColors' | 'on' | 'off'>;
  openApp(): void;
  quit(): void;
  onError(error: unknown): void;
  loadFont?(): Promise<MenuBarFont>;
  logo?: MenuBarLogo;
}) {
  const sources = new Set<UsageSource>();
  let selected: UsageSource | null = null;
  let lastSnapshot: CodexAccountsSnapshot | null = null;
  let disposed = false;
  let iconKey = '';
  let font: MenuBarFont | undefined;
  const icon = (percent: number | null) => {
    const template = !isLowAccountUsage(percent);
    const image = options.images.createEmpty();
    for (const scaleFactor of [1, 2]) {
      image.addRepresentation({ scaleFactor, buffer: renderAccountUsageTrayIcon(percent, {
        scaleFactor, template, dark: options.theme.shouldUseDarkColors, font, logo: options.logo,
      }) });
    }
    image.setTemplateImage(template);
    return image;
  };
  const tray = options.createTray(icon(null));

  const reveal = () => {
    const window = selected?.window;
    if (!window || window.isDestroyed()) { options.openApp(); return; }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const renderCurrent = () => {
    if (disposed) return;
    const snapshot = selected?.snapshot ?? lastSnapshot;
    lastSnapshot = snapshot;
    const totals = accountUsageTotals(snapshot);
    const active = snapshot?.profiles.find(profile => profile.id === snapshot.activeId);
    const activeUsage = active ? accountUsageTotals({ activeId: active.id, profiles: [active] }) : null;
    const percent = activeUsage?.percent ?? null;
    const key = `${percent}:${options.theme.shouldUseDarkColors}`;
    if (key !== iconKey) { tray.setImage(icon(percent)); iconKey = key; }
    const summary = totals
      ? `${totals.remaining}% remaining · ${totals.capacity}% total capacity · ${totals.accountCount} accounts`
      : 'Usage unavailable';
    const activeSummary = active ? `\n${active.email ?? active.label} · Ring: ${activeUsage ? `${activeUsage.remaining}% remaining` : 'Unavailable'}` : '';
    tray.setToolTip(`Cheshi · ${summary}${activeSummary}`);
    const menu: MenuItemConstructorOptions[] = [{ label: 'Cheshi · Weekly usage', enabled: false },
      { label: summary, enabled: false }, { type: 'separator' }];
    for (const profile of snapshot?.profiles ?? []) {
      const total = accountUsageTotals({ activeId: profile.id, profiles: [profile] });
      const value = total ? `${total.remaining}% remaining` : 'Unavailable';
      menu.push({ label: `${profile.email ?? profile.label} · ${value}`, type: 'checkbox',
        checked: profile.id === snapshot?.activeId, enabled: false });
    }
    if (snapshot?.profiles.length) menu.push({ type: 'separator' });
    menu.push({ label: 'Show Cheshi', click: reveal }, { label: 'Quit Cheshi', click: options.quit });
    tray.setContextMenu(options.createMenu(menu));
  };
  const render = () => {
    try { renderCurrent(); }
    catch (error) { options.onError(error); }
  };
  options.theme.on('updated', render);
  render();
  void options.loadFont?.().then(loaded => {
    if (disposed) return;
    font = loaded;
    iconKey = '';
    render();
  }).catch(options.onError);

  return {
    updateBackground(snapshot: CodexAccountsSnapshot) {
      if (disposed) return;
      // Registry snapshots use the default account; preserve the last workspace selection.
      lastSnapshot = { ...snapshot, activeId: selected?.snapshot?.activeId ?? lastSnapshot?.activeId ?? snapshot.activeId };
      render();
    },
    register() {
      const source: UsageSource = { snapshot: null, window: null, detach() {} };
      let removed = disposed;
      if (!removed) sources.add(source);
      const remove = () => {
        if (removed) return;
        removed = true;
        source.detach();
        sources.delete(source);
        if (selected === source) selected = [...sources].at(-1) ?? null;
        render();
      };
      return {
        update(snapshot: CodexAccountsSnapshot) {
          if (removed || disposed) return;
          source.snapshot = snapshot;
          selected ??= source;
          render();
        },
        attach(window: UsageWindow) {
          if (removed || disposed || window.isDestroyed()) return;
          source.detach();
          source.window = window;
          const focus = () => { if (!removed && !disposed) { selected = source; render(); } };
          window.on('focus', focus);
          window.on('closed', remove);
          source.detach = () => { window.off('focus', focus); window.off('closed', remove); };
          if (window.isFocused() || !selected) selected = source;
          render();
        },
        dispose: remove,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.theme.off('updated', render);
      for (const source of sources) source.detach();
      sources.clear();
      selected = null;
      lastSnapshot = null;
      tray.destroy();
    },
  };
}
