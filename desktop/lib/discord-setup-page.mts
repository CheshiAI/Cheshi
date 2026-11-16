/** Serialized into an isolated renderer world. No arbitrary agent JavaScript. */
export function discordSetupPage(input: { action: string; ref?: string; text?: string; direction?: string }) {
  const win = window as unknown as { __cheshiSetup?: { version: string; page: string; elements: Element[] } };
  const clean = (text: string) => text.replace(/\b(?:mfa\.[\w-]+|[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,})\b/g, '[redacted]')
    .replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z_-])[A-Za-z0-9_-]{32,}\b/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 160);
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const label = (el: Element) => clean(el.getAttribute('aria-label')
    || el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
    || el.getAttribute('placeholder')
    || (el instanceof HTMLInputElement && el.labels?.length ? [...el.labels].map(item => item.textContent).join(' ') : '')
    || el.textContent || el.getAttribute('name') || el.tagName);
  const sensitive = /token|secret|password|credential|authorize|authorise|delete|remove|reset|revoke|transfer ownership|log out|sign out|purchase|billing|payment|agree|terms|토큰|비밀번호|삭제|초기화|승인|약관/i;
  const protectedPage = /\/(?:login|register|oauth2\/authorize|verify|reset|mfa)(?:\/|$)/.test(location.pathname)
    || [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],iframe[src*="captcha"]')].some(visible);
  if (protectedPage) {
    win.__cheshiSetup = undefined;
    return { status: 'user-action-required', reason: 'Complete login, verification or authorization in the setup window, then tell the assistant to continue.' };
  }
  const disabled = (el: Element) => el.getAttribute('aria-disabled') === 'true' || ('disabled' in el && el.disabled === true);
  const blocked = (el: Element) => sensitive.test(label(el))
    || (el instanceof HTMLInputElement && ['password', 'email', 'file', 'hidden'].includes(el.type))
    || el.closest('[contenteditable="true"]') !== null;
  if (input.action === 'inspect') {
    const version = crypto.randomUUID();
    const elements = [...document.querySelectorAll('button,a[href],input,select,[role="button"],[role="link"],[role="treeitem"],[role="switch"],[role="checkbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="radio"],[role="option"],[role="combobox"],[role="tab"]')]
      .filter(visible).slice(0, 250);
    win.__cheshiSetup = { version, page: location.href, elements };
    return { status: 'ready', headings: [...document.querySelectorAll('h1,h2,h3,[role="dialog"] > [role="heading"]')].filter(visible).map(el => clean(el.textContent ?? '')).slice(0, 25),
      controls: elements.map((el, i) => ({ ref: `${version}:${i}`, role: el.getAttribute('role') || el.tagName.toLowerCase(), label: label(el),
        disabled: disabled(el), userOnly: blocked(el), checked: el.getAttribute('aria-checked') ?? (el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : null) })) };
  }
  if (input.action === 'scroll') {
    const delta = input.direction === 'up' ? -600 : 600;
    const containers = [...document.querySelectorAll('*')].filter(el => visible(el) && el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY));
    const container = containers.sort((a, b) => b.clientHeight - a.clientHeight)[0];
    if (container) container.scrollBy(0, delta); else window.scrollBy(0, delta);
    win.__cheshiSetup = undefined; return { status: 'inspect-again' };
  }
  const state = win.__cheshiSetup;
  const index = state && input.ref?.startsWith(`${state.version}:`) ? Number(input.ref.slice(state.version.length + 1)) : -1;
  const el = state && Number.isSafeInteger(index) ? state.elements[index] : undefined;
  if (!el || state?.page !== location.href || !el.isConnected || !visible(el)) return { status: 'inspect-again' };
  if (disabled(el) || blocked(el)) return { status: 'user-action-required', reason: 'This control requires direct user interaction.' };
  if (input.action === 'copy_id' && !/copy.*(?:server|user).*id|(?:서버|사용자).*id.*복사/i.test(label(el))) {
    return { status: 'blocked', reason: 'Only Copy Server ID or Copy User ID is allowed.' };
  }
  if (input.action === 'fill') {
    if (!(el instanceof HTMLInputElement) || !['text', 'search', 'url'].includes(el.type) || el.readOnly
      || typeof input.text !== 'string' || input.text.length > 100 || /[\r\n]/.test(input.text)) return { status: 'blocked' };
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, input.text);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (input.action === 'click' || input.action === 'copy_id' || input.action === 'context_menu') {
    const anchor = el.closest('a[href]');
    if (anchor instanceof HTMLAnchorElement) {
      const url = new URL(anchor.href);
      if (url.origin !== 'https://discord.com' || !/^\/(developers\/applications|channels|login|oauth2\/authorize)(\/|$)/.test(url.pathname)) return { status: 'blocked' };
    }
    if (input.action === 'context_menu') {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    } else (el as HTMLElement).click();
  } else return { status: 'blocked' };
  win.__cheshiSetup = undefined;
  return { status: 'action-performed', next: 'Inspect before the next action.' };
}
