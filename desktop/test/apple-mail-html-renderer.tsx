// Browser fixture bundled only by apple-mail-html-electron.test.ts.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { MailSend } from '../shared/apple-mail';
import { mailComposer } from '../frontend/src/features/mail/mailComposer';
import { MailBrowser } from '../frontend/src/features/mail/MailView';
import { mailHtmlDocument, mailLink } from '../frontend/src/features/mail/mailHtmlDocument';
import { mailEditableDocument } from '../frontend/src/features/mail/mailEditableDocument';
import { mailReplyDocument, serializeReplyDocument } from '../frontend/src/features/mail/mailReplyDocument';
import { applyMailReadBodyPadding } from '../frontend/src/features/mail/mailReadBodyPadding';
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
let sent: MailSend | undefined;
const api = mailApiFixture({
  send: async input => { sent = input; return mailSuccess({ operationId: input.operationId, accepted: true }); },
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
  return { first, repeated, narrow };
}

function action(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label)!;
}

function replyLayout() {
  const editor = frame();
  const doc = editor.contentDocument!;
  const article = editor.closest('article')!;
  return { width: editor.getBoundingClientRect().width, available: article.clientWidth,
    below: doc.querySelector('blockquote')!.getBoundingClientRect().top >= doc.body.firstElementChild!.getBoundingClientRect().bottom,
    focused: document.activeElement === editor && doc.activeElement === doc.body, modal: document.querySelector('dialog') !== null,
    originalTitle: doc.querySelector('h1')?.textContent,
    consent: button() === undefined, overflow: article.scrollWidth > article.clientWidth };
}

async function editorReady(title: string) {
  await waitFor(() => frame()?.title === 'Reply message editor' && frame().contentDocument?.body?.isContentEditable === true
    && frame().contentDocument?.querySelector('h1')?.textContent === title);
  await pause();
}

async function prepareReply() {
  document.getElementById('root')!.style.width = '1200px';
  flushSync(() => action('Reply').click());
  await editorReady('Newsletter');
  return replyLayout();
}

async function finishReply() {
  const doc = frame().contentDocument!;
  const typed = doc.body.firstElementChild!.textContent;
  function select(node: Node) {
    const range = doc.createRange(); range.selectNodeContents(node);
    doc.getSelection()!.removeAllRanges(); doc.getSelection()!.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
  }
  select(doc.body.firstElementChild!);
  flushSync(() => action('Bold').click());
  const bold = frame().contentWindow!.getComputedStyle(doc.body.firstElementChild!.firstElementChild!).fontWeight;
  select(doc.querySelector('h1')!);
  doc.execCommand('insertText', false, 'Edited original');
  const quote = doc.querySelector('blockquote')!;
  const range = doc.createRange(); range.selectNode(quote);
  doc.getSelection()!.removeAllRanges(); doc.getSelection()!.addRange(range);
  doc.execCommand('delete');
  const deleted = !doc.querySelector('blockquote');
  doc.execCommand('undo');
  doc.dispatchEvent(new Event('input'));
  document.getElementById('root')!.style.width = '700px';
  await pause();
  const narrow = replyLayout();
  flushSync(() => action('Close reply').click());
  flushSync(() => action('Reply').click());
  await editorReady('Edited original');
  const retained = frame().contentDocument!.body.firstElementChild!.textContent;
  flushSync(() => action('Send').click());
  await waitFor(() => !!sent && !mailComposer(api).getSnapshot().busy);
  const sentDocument = new DOMParser().parseFromString(sent!.html!, 'text/html');
  const payload = { text: sent!.body.includes('Inline reply text'), title: sentDocument.querySelector('h1')?.textContent,
    bold: sentDocument.body.firstElementChild?.innerHTML.includes('font-weight: bold'),
    quote: !!sentDocument.querySelector('blockquote'), image: !!sentDocument.querySelector('img[src^="data:image/"]'),
    editable: !!sentDocument.querySelector('[contenteditable]') };
  flushSync(() => root.unmount());
  return { typed, bold, deleted, retained, narrow, payload };
}

async function colorDefaults() {
  const colorFrame = document.createElement('iframe');
  colorFrame.style.cssText = 'position:absolute;left:-10000px;width:800px;height:600px;visibility:hidden';
  colorFrame.setAttribute('sandbox', 'allow-same-origin');
  document.body.append(colorFrame);
  const fixtures = [
    { name: 'missing', html: '<p id="sample" style="color:#c02030">Exact red</p>' },
    { name: 'stylesheet', html: '<style>:where(body){color:#2468ac;background:#f4e59a}span{font-size:32px!important;padding:10px!important;color:white!important;background:black!important}</style><p id="sample">CSS colors</p>' },
    { name: 'inline', html: '<body style="color:#abcdef;background:#123456"><p id="sample" style="color:#c02030">Inline colors</p></body>' },
    { name: 'root', html: '<html style="color:#eeeeee;background:#203040"><body><p id="sample">Inherited colors</p></body></html>' },
    { name: 'legacy', html: '<body text="#654321" bgcolor="#fedcba"><p id="sample">Legacy colors</p></body>' },
    { name: 'plain', html: undefined },
  ];
  const results = [];
  const references = [];
  try {
    for (const fixture of fixtures) {
      const editable = mailEditableDocument(fixture.html, 'Plain text', `color-${fixture.name}`, '');
      const output = editable.apply({ ...editable.request, model: 'fixture' });
      await new Promise<void>(resolve => {
        colorFrame.onload = () => resolve();
        colorFrame.srcdoc = output.html;
      });
      const view = colorFrame.contentWindow!;
      const doc = colorFrame.contentDocument!;
      const body = fixture.name === 'plain' ? doc.querySelector('div')! : doc.body;
      const sample = doc.getElementById('sample') ?? body;
      results.push({ name: fixture.name, color: view.getComputedStyle(body).color,
        background: view.getComputedStyle(body).backgroundColor, sample: view.getComputedStyle(sample).color });
      const reference = doc.querySelector('[data-cheshi-mail-color-reference]');
      if (reference) {
        const size = reference.getBoundingClientRect();
        const before = sample.getBoundingClientRect();
        const color = view.getComputedStyle(reference).color;
        reference.remove();
        const after = sample.getBoundingClientRect();
        references.push({ name: fixture.name, width: size.width, height: size.height, color,
          stable: before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height });
      }
    }
    return { cases: results, references };
  } finally { colorFrame.remove(); }
}

async function fontSizes() {
  const fontFrame = document.createElement('iframe');
  fontFrame.style.cssText = 'position:absolute;left:-10000px;width:800px;height:600px;visibility:hidden';
  fontFrame.setAttribute('sandbox', 'allow-same-origin');
  document.body.append(fontFrame);
  const load = (html: string) => new Promise<void>(resolve => {
    fontFrame.onload = () => resolve(); fontFrame.srcdoc = html;
  });
  const ids = ['default', 'explicit', 'rule', 'relative', 'formatted', 'large', 'quote', 'heading'];
  const sizes = () => ids.map(id => fontFrame.contentWindow!.getComputedStyle(fontFrame.contentDocument!.getElementById(id)!).fontSize);
  try {
    await load('<html><head><style>body{font:12px Helvetica}#rule{font-size:12px!important}h1{font-size:37px}</style></head>'
      + '<body>Bare text<p id="default">Default</p><p id="explicit" style="font-size:12px">Explicit</p>'
      + '<p id="rule">Stylesheet</p><div style="font-size:24px"><span id="relative" style="font-size:50%">Relative</span></div>'
      + '<p id="formatted"><b><i><u>Formatted</u></i></b></p>'
      + '<p id="large" style="font-size:24px">Large</p><blockquote><p id="quote">Quoted</p><h1 id="heading">Heading</h1></blockquote></body></html>');
    const before = sizes();
    const live = fontFrame.contentDocument!;
    const original = live.documentElement.outerHTML;
    const serialized = serializeReplyDocument(live);
    const unchanged = live.documentElement.outerHTML === original;
    const editable = mailEditableDocument(serialized, '', 'font-sizes', '');
    const outgoing = editable.apply({ ...editable.request, model: 'fixture' });
    const snapshot = new DOMParser().parseFromString(outgoing.html, 'text/html');
    const points = ['default', 'explicit', 'rule', 'relative', 'formatted', 'quote'].map(id => (snapshot.getElementById(id) as HTMLElement).style.fontSize);
    const bare = (snapshot.body.firstElementChild as HTMLElement).style.fontSize;
    await load(outgoing.html);
    const after = sizes();
    const fresh = mailReplyDocument({ ...message, html: '<p>Original</p>' }, window);
    await load(fresh);
    const freshDefault = fontFrame.contentWindow!.getComputedStyle(fontFrame.contentDocument!.body.firstElementChild!).fontSize;
    const plain = mailEditableDocument(undefined, 'Plain text', 'plain-font', '');
    await load(plain.apply({ ...plain.request, model: 'fixture' }).html);
    const plainDefault = fontFrame.contentWindow!.getComputedStyle(fontFrame.contentDocument!.querySelector('div')!).fontSize;
    return { before, after, points, bare, unchanged, freshDefault, plainDefault };
  } finally { fontFrame.remove(); }
}

async function readBodyPadding() {
  const preview = document.createElement('iframe');
  preview.style.cssText = 'position:absolute;left:-10000px;width:550px;height:600px;visibility:hidden;border:0';
  preview.setAttribute('sandbox', 'allow-same-origin');
  document.body.append(preview);
  const results = [];
  try {
    for (const nested of [false, true]) {
      for (const width of [550, 320]) {
        preview.style.width = `${width}px`;
        const reply = '<p id="reply" style="font-size:18px;color:#c02030">Reply text</p>';
        const quote = '<blockquote type="cite" style="margin:16px 0 0;padding-left:12px;font-size:12px">'
          + '<p id="quote">Original</p><blockquote type="cite" style="margin:inherit;padding:inherit"><p id="nested">Earlier reply</p></blockquote></blockquote>';
        const source = nested ? `<div><div>${reply}${quote}</div></div>` : reply + quote;
        await new Promise<void>(resolve => {
          preview.onload = () => resolve();
          preview.srcdoc = mailHtmlDocument(source, [], false, window).srcDoc;
        });
        const doc = preview.contentDocument!;
        const view = preview.contentWindow!;
        const sample = (id: string) => {
          const element = doc.getElementById(id)!;
          const box = element.getBoundingClientRect();
          const style = view.getComputedStyle(element);
          return { left: box.left, width: box.width, font: style.fontSize, color: style.color };
        };
        const before = { reply: sample('reply'), quote: sample('quote'), nested: sample('nested') };
        const quoteHtml = doc.querySelector('blockquote')!.outerHTML;
        applyMailReadBodyPadding(doc.body);
        const after = { reply: sample('reply'), quote: sample('quote'), nested: sample('nested') };
        results.push({ nested, width, before, after, quoteUnchanged: quoteHtml === doc.querySelector('blockquote')!.outerHTML,
          overflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth });
      }
    }
    return results;
  } finally { preview.remove(); }
}

Object.assign(window, { mailChecks: { prepare, allowImages, switchMessage, reselectMessage, prepareReply, finishReply, colorDefaults, fontSizes, readBodyPadding } });
