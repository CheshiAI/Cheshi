// Browser fixture bundled only by apple-mail-html-electron.test.ts.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { MailSend } from '../shared/apple-mail';
import { mailComposer } from '../frontend/src/features/mail/mailComposer';
import { MailBrowser } from '../frontend/src/features/mail/MailView';
import { mailHtmlDocument, mailLink } from '../frontend/src/features/mail/mailHtmlDocument';
import { mailEditableDocument } from '../frontend/src/features/mail/mailEditableDocument';
import { mailReplyDocument, serializeReplyDocument } from '../frontend/src/features/mail/mailReplyDocument';
import { MailHtmlBody } from '../frontend/src/features/mail/MailHtmlBody';
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
const reader = () => document.querySelector<HTMLElement>('[aria-label="HTML message content"]')!;
const readTree = () => reader()?.shadowRoot!;
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
  await waitFor(() => readTree()?.querySelector('h1')?.textContent === 'Newsletter');
  await pause();
}
function widths() {
  const current = reader();
  const doc = readTree();
  const layout = doc.getElementById('layout')!;
  const parent = layout.parentElement!;
  const style = getComputedStyle(parent);
  return { article: current.closest('article')!.clientWidth, host: current.getBoundingClientRect().width,
    layout: layout.getBoundingClientRect().width,
    available: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    columns: doc.getElementById('columns')!.getBoundingClientRect().width,
    logo: doc.getElementById('logo')!.getBoundingClientRect().width,
    overflow: doc.querySelector('html')!.scrollWidth > current.clientWidth };
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
  flushSync(() => root.render(<MailBrowser api={api} />));
  await waitFor(() => document.querySelectorAll('[aria-label="Message list"] button[aria-pressed]').length === 2);
  await selectMessage(0);
  const live = readTree();
  const display = {
    title: live.querySelector('h1')?.textContent,
    font: getComputedStyle(live.querySelector('h1')!).fontSize,
    background: getComputedStyle(live.querySelector('body')!).backgroundColor,
    loadedImage: (live.querySelector('#logo') as HTMLImageElement).naturalWidth,
    iframes: document.querySelectorAll('iframe').length,
    button: button()?.textContent,
    hostFont: getComputedStyle(document.getElementById('host-title')!).fontSize,
  };
  return { formatting, display, compromised: Object.hasOwn(window, 'compromised') };
}

async function allowImages() {
  flushSync(() => button()!.click());
  await waitFor(() => (readTree()?.querySelector('img[src^="https:"]') as HTMLImageElement | null)?.naturalWidth === 1);
  await pause();
  const doc = readTree();
  const href = doc.querySelector('a[href]')!;
  // Parent listener routes validated links to the normal external browser handler.
  href.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const remote = doc.querySelector('img[src^="https:"]') as HTMLImageElement;
  return { button: button()?.textContent ?? null, source: remote.getAttribute('src'), naturalWidth: remote.naturalWidth, widths: widths() };
}

async function switchMessage() {
  await selectMessage(1);
  const result = { button: button()?.textContent, remoteSources: readTree().querySelectorAll('img[src^="https:"]').length };
  return result;
}

async function reselectMessage() {
  await selectMessage(0);
  await waitFor(() => (readTree()?.querySelector('img[src^="https:"]') as HTMLImageElement | null)?.naturalWidth === 1);
  const first = { button: button()?.textContent ?? null, naturalWidth: (readTree().querySelector('img[src^="https:"]') as HTMLImageElement).naturalWidth };
  await selectMessage(0);
  const repeated = { button: button()?.textContent ?? null, remoteSources: readTree().querySelectorAll('img[src^="https:"]').length };
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
  const preview = document.createElement('div');
  preview.style.cssText = 'position:absolute;left:-10000px;width:550px;visibility:hidden';
  document.body.append(preview);
  const fixture = createRoot(preview);
  const results = [];
  const reply = '<p id="reply" style="font-size:18px;color:#c02030">Reply text</p>';
  const quote = '<blockquote type="cite" style="margin:16px 0 0;padding-left:12px;font-size:12px;color:#123456">'
    + '<p id="quote">Original</p><blockquote type="cite" style="margin:inherit;padding:inherit"><p id="nested">Earlier reply</p></blockquote></blockquote>';
  try {
    for (const source of [reply + quote, `<div><div>${reply}${quote}</div></div>`, quote, reply]) {
      for (const width of [550, 320]) {
        preview.style.width = `${width}px`;
        const srcDoc = mailHtmlDocument(source, [], false, window).srcDoc;
        flushSync(() => fixture.render(<MailHtmlBody srcDoc={srcDoc} />));
        const host = preview.querySelector<HTMLElement>('[aria-label="HTML message content"]')!;
        const tree = host.shadowRoot!;
        const container = host.parentElement!;
        const sample = (id: string) => {
          const element = tree.getElementById(id);
          if (!element) return null;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { left: box.left, width: box.width, font: style.fontSize, color: style.color };
        };
        container.style.paddingInline = '0';
        const before = { reply: sample('reply'), quote: sample('quote'), nested: sample('nested') };
        const quoteHtml = tree.querySelector('blockquote')?.outerHTML;
        container.style.removeProperty('padding-inline');
        const after = { reply: sample('reply'), quote: sample('quote'), nested: sample('nested') };
        const draft = mailReplyDocument({ ...message, html: source }, window);
        const outgoing = serializeReplyDocument(new DOMParser().parseFromString(draft, 'text/html'));
        results.push({ width, before, after,
          quoteUnchanged: quoteHtml === tree.querySelector('blockquote')?.outerHTML,
          padding: [getComputedStyle(container).paddingLeft, getComputedStyle(container).paddingRight],
          outgoingClean: !/--text|--cheshi-mail-read|cheshi-mail-body|data-cheshi-mail-read-padding/.test(outgoing),
          overflow: tree.querySelector('html')!.scrollWidth > host.clientWidth });
      }
    }
    return results;
  } finally { flushSync(() => fixture.unmount()); preview.remove(); }
}

async function readBackgrounds() {
  const preview = document.createElement('div');
  preview.style.cssText = 'position:absolute;left:-10000px;width:550px;height:600px;border:0';
  document.body.append(preview);
  const fixture = createRoot(preview);
  const results = [];
  const panel = '<center><table id="envelope" bgcolor="#f0f0f0"><tr><td></td><td>'
    + '<table id="content" bgcolor="#ffffff"><tr><td><p>Content</p><div id="nested" style="background:#f0f0f0"><p>Authored panel</p></div></td></tr></table>'
    + '</td><td></td></tr></table></center><table id="footer" bgcolor="#f0f0f0"><tr><td>Footer</td></tr></table>';
  try {
    for (const [name, source] of [
      ['legacy', `<body bgcolor="#f0f0f0">${panel}</body>`],
      ['stylesheet', `<style>body{background:#f0f0f0!important}</style>${panel}`],
      ['root', `<html style="background:#f0f0f0"><body>${panel}</body></html>`],
      ['single', '<body style="background:#123456;color:white"><p>Single content surface</p></body>'],
      ['white', '<body style="background:white"><p>Authored white background</p></body>'],
      ['transparent', '<body style="background:transparent"><p>Authored transparent background</p></body>'],
      ['default', '<p>No authored background</p>'],
      ['authored-text', '<html style="color:#345678"><body><p>Authored text color</p></body></html>'],
    ]) {
      flushSync(() => fixture.render(<MailHtmlBody srcDoc={mailHtmlDocument(source!, [], false, window).srcDoc} />));
      const tree = preview.querySelector('[aria-label="HTML message content"]')!.shadowRoot!;
      const colors = [tree.querySelector('html'), tree.querySelector('body'), ...['envelope', 'content', 'nested', 'footer'].map(id => tree.getElementById(id))]
        .map(element => element ? getComputedStyle(element).backgroundColor : null);
      const textColor = getComputedStyle(tree.querySelector('p')!).color;
      preview.style.setProperty('--text', '#abcdef');
      const themedColor = getComputedStyle(tree.querySelector('p')!).color;
      preview.style.removeProperty('--text');
      results.push({ name, colors, textColor, themedColor });
    }
    return results;
  } finally { flushSync(() => fixture.unmount()); preview.remove(); }
}


async function shadowReading() {
  const container = document.createElement('div');
  container.style.cssText = 'width:400px;height:200px;overflow:auto';
  document.body.append(container);
  const fixture = createRoot(container);
  const appBackground = document.documentElement.style.backgroundColor;
  const appFont = getComputedStyle(document.getElementById('host-title')!).fontSize;
  const source = String.raw`<html><head><style>
    @import url(https://mail-fixture.invalid/shadow-import);
    @font-face{font-family:leak;src:url(https://mail-fixture.invalid/shadow-font)}
    :host{position:fixed;width:9000px!important;background:red!important}
    :host-context(body){display:none!important}
    ::slotted(*){color:red!important}
    :root{background:#f0f0f0}body{color:#123456;font-family:Arial;font-size:12px}
    #long{height:24px!important;max-height:24px!important;overflow:auto!important}
    .escape{background-image:u\72l(https://mail-fixture.invalid/shadow-escaped)}
    .image-set{background-image:image-set("https://mail-fixture.invalid/shadow-set" 1x)}
    @media(min-width:1px){.emphasis{font-size:18px;color:rgb(200,30,40)}}
    .variables{--resource:url(https://mail-fixture.invalid/shadow-var);background:var(--resource)}
  </style><meta http-equiv="refresh" content="0;url=https://mail-fixture.invalid/redirect"></head>
  <body onload="window.compromised=true" background="https://mail-fixture.invalid/shadow-background">
  <div style="background:white"><p class="emphasis">Preserved format</p>
  <div id="long" style="height:24px;overflow:scroll;position:fixed;inset:0">
  ${Array.from({ length: 40 }, (_, index) => `<p>Line ${index}</p>`).join('')}
  <blockquote type="cite" style="margin-bottom:48px"><p id="last">Final quoted line</p></blockquote></div>
  <p class="escape image-set variables">Passive content</p>
  <img src="https://mail-fixture.invalid/shadow-img" onerror="window.compromised=true">
  <a href="javascript:window.compromised=true">Unsafe link</a>
  <script>window.compromised=true</script><iframe src="https://mail-fixture.invalid/shadow-frame"></iframe>
  <form><input autofocus><button>Submit</button></form><slot></slot>
  </div></body></html>`;
  try {
    flushSync(() => fixture.render(<MailHtmlBody srcDoc={source} />));
    await pause();
    const host = container.querySelector<HTMLElement>('[aria-label="HTML message content"]')!;
    const tree = host.shadowRoot!;
    const before = host.getBoundingClientRect().height;
    const image = document.createElement('img');
    image.style.width = '320px';
    image.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
    const loaded = new Promise<void>(resolve => { image.onload = () => resolve(); });
    tree.querySelector('body')!.append(image);
    await loaded;
    await pause();
    const after = host.getBoundingClientRect().height;
    return {
      iframes: container.querySelectorAll('iframe').length + tree.querySelectorAll('iframe').length,
      active: tree.querySelectorAll('script,form,input,button,slot,meta,link,[onload],[onerror],a[href^="javascript:"]').length,
      compromised: Object.hasOwn(window, 'compromised'),
      hostStable: appBackground === document.documentElement.style.backgroundColor
        && appFont === getComputedStyle(document.getElementById('host-title')!).fontSize,
      hostWidth: host.getBoundingClientRect().width,
      naturalHeight: before > 500 && after >= before + 319,
      outerScroll: container.scrollHeight > container.clientHeight,
      innerScroll: [...tree.querySelectorAll<HTMLElement>('html,body,#long')].some(element =>
        ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) || element.scrollHeight > element.clientHeight + 1),
      font: getComputedStyle(tree.querySelector('.emphasis')!).fontSize,
      color: getComputedStyle(tree.querySelector('.emphasis')!).color,
      lastLineVisible: tree.querySelector('#last')!.getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom,
      leakedRules: [...tree.querySelectorAll('html style')].some(style => /:host|::slotted|@font-face|@import|image-set|var\(/i.test(style.textContent ?? '')),
    };
  } finally { flushSync(() => fixture.unmount()); container.remove(); }
}

Object.assign(window, { mailChecks: { prepare, allowImages, switchMessage, reselectMessage, prepareReply, finishReply, colorDefaults, fontSizes, readBodyPadding, readBackgrounds, shadowReading } });
