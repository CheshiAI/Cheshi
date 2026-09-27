import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { discordSetupPage } from '../lib/discord-setup-page.mts';

function withPage(html: string, run: () => void, url = 'https://discord.com/developers/applications/123/bot') {
  const win = new Window({ url });
  const globals = { window: win, document: win.document, location: win.location, HTMLInputElement: win.HTMLInputElement,
    HTMLAnchorElement: win.HTMLAnchorElement, HTMLElement: win.HTMLElement, Event: win.Event, MouseEvent: win.MouseEvent,
    getComputedStyle: win.getComputedStyle.bind(win) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  win.HTMLElement.prototype.getBoundingClientRect = () => new win.DOMRect(0, 0, 100, 30);
  win.document.body.innerHTML = html;
  try { run(); } finally {
    void win.happyDOM.abort();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
}
const inspect = () => discordSetupPage({ action: 'inspect' });
test('snapshots hide input values, redact credentials and reserve sensitive controls for the user', () => {
  const secret = 'ABCdef12345678901234567890.abcdef.ABCdef12345678901234567890123456';
  withPage(`<h1>Bot</h1><input aria-label="Bot token" value="${secret}"><button>Reset Token</button><button>${secret}</button><button>Save</button>`, () => {
    const page = inspect();
    expect(JSON.stringify(page)).not.toContain(secret);
    const reset = page.controls!.find(c => c.label === 'Reset Token')!;
    expect(reset.userOnly).toBe(true);
    expect(discordSetupPage({ action: 'click', ref: reset.ref }).status).toBe('user-action-required');
  });
});
test('Discord server tree items and settings links without href can be discovered and operated', () => {
  withPage('<div role="treeitem" tabindex="-1" aria-label="서버 추가하기"></div><div role="link" tabindex="-1">개발자</div><a role="link" tabindex="0">Advanced</a>', () => {
    const actions: string[] = [];
    for (const el of document.body.children) el.addEventListener('click', () => actions.push(el.getAttribute('aria-label') || el.textContent!));
    for (const label of ['서버 추가하기', '개발자', 'Advanced']) {
      const control = inspect().controls!.find(c => c.label === label)!;
      expect(control).toBeDefined();
      expect(discordSetupPage({ action: 'click', ref: control.ref }).status).toBe('action-performed');
    }
    expect(actions).toEqual(['서버 추가하기', '개발자', 'Advanced']);
  }, 'https://discord.com/channels/@me');
});
test('right-click reveals an ID menu and respects stale refs and protected controls', () => {
  withPage('<div role="treeitem" aria-label="Personal server"></div><button>Reset Token</button>', () => {
    let button: number | undefined;
    document.querySelector('[role="treeitem"]')!.addEventListener('contextmenu', event => {
      button = (event as MouseEvent).button;
      const menu = document.createElement('div'); menu.setAttribute('role', 'menuitem'); menu.textContent = 'Copy Server ID'; document.body.append(menu);
    });
    const server = inspect().controls!.find(c => c.role === 'treeitem')!;
    expect(discordSetupPage({ action: 'context_menu', ref: server.ref }).status).toBe('action-performed');
    expect(button).toBe(2);
    expect(discordSetupPage({ action: 'context_menu', ref: server.ref }).status).toBe('inspect-again');
    const copy = inspect().controls!.find(c => c.label === 'Copy Server ID')!;
    expect(discordSetupPage({ action: 'copy_id', ref: copy.ref }).status).toBe('action-performed');
    const reset = inspect().controls!.find(c => c.label === 'Reset Token')!;
    expect(discordSetupPage({ action: 'context_menu', ref: reset.ref }).status).toBe('user-action-required');
  });
});
test('new link roles cannot bypass external navigation restrictions', () => {
  withPage('<a href="https://example.com"><span role="link">External</span></a>', () => {
    const child = inspect().controls!.find(c => c.role === 'link')!;
    expect(discordSetupPage({ action: 'click', ref: child.ref }).status).toBe('blocked');
  });
});
test('ordinary setup controls can be filled and clicked, with stale refs rejected', () => {
  withPage('<label>Name<input type="text"></label><button>Create</button>', () => {
    let clicks = 0;
    document.querySelector('button')!.addEventListener('click', () => { clicks++; });
    const before = inspect();
    const input = before.controls!.find(c => c.role === 'input')!;
    expect(discordSetupPage({ action: 'fill', ref: input.ref, text: 'Cheshi Personal' }).status).toBe('action-performed');
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('Cheshi Personal');
    expect(discordSetupPage({ action: 'click', ref: before.controls!.find(c => c.label === 'Create')!.ref }).status).toBe('inspect-again');
    const create = inspect().controls!.find(c => c.label === 'Create')!;
    expect(discordSetupPage({ action: 'click', ref: create.ref }).status).toBe('action-performed'); expect(clicks).toBe(1);
  });
});
test('authentication pages and external links cannot be automated', () => {
  withPage('<button>Authorize</button>', () => {
    expect(inspect()).toMatchObject({ status: 'user-action-required' });
    expect(inspect()).not.toHaveProperty('controls');
  }, 'https://discord.com/oauth2/authorize?secret=not-returned');
  withPage('<a href="https://example.com">Continue</a><button>Copy Token</button>', () => {
    const controls = inspect().controls!;
    expect(discordSetupPage({ action: 'click', ref: controls[0]!.ref }).status).toBe('blocked');
    expect(discordSetupPage({ action: 'copy_id', ref: controls[1]!.ref }).status).toBe('user-action-required');
  });
});
