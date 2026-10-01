import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mailEditableDocument } from '../frontend/src/features/mail/mailEditableDocument';
import { applyMailDocumentColors } from '../frontend/src/features/mail/mailDocumentColors';
import { serializeReplyDocument } from '../frontend/src/features/mail/mailReplyDocument';

function withMailWindow(operation: (window: Window) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = new Window();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  try { operation(window); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
    void window.happyDOM.abort();
  }
}

test('only authored text changes; HTML, image data, attributes, quotes and signatures are retained', () => {
  withMailWindow(window => {
    const html = '<p style="color:red">안녕 <b>하세요</b><a href="https://example.test">링크</a></p>'
      + '<img src="data:image/png;base64,AAAA"><blockquote><table><tr><td>원문</td></tr></table></blockquote>'
      + '<div class="AppleMailSignature">서명</div>';
    const editable = mailEditableDocument(html, '', 'request', '원문');
    expect(editable.request.segments.map(segment => segment.text)).toEqual(['안녕 ', '하세요', '링크']);
    const result = editable.apply({ requestId: 'request', model: 'test', segments: editable.request.segments.map(segment => ({ ...segment, text: '<script>text only</script>' })) });
    const doc = new window.DOMParser().parseFromString(result.html, 'text/html');
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('p')!.getAttribute('style')).toBe('color:red');
    expect(doc.querySelector('a')!.getAttribute('href')).toBe('https://example.test');
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(doc.querySelector('blockquote')!.textContent).toBe('원문');
    expect(doc.querySelector('.AppleMailSignature')!.textContent).toBe('서명');
    expect(doc.querySelector('td')!.textContent).toBe('원문');
    expect(() => editable.apply({ requestId: 'wrong', model: 'test', segments: editable.request.segments })).toThrow();
  });
});
test('plain replies become escaped HTML and empty authored replies cannot send only a quotation', () => {
  const editable = mailEditableDocument(undefined, 'a < b\nsecond', 'plain', '');
  const { html } = editable.apply({ ...editable.request, model: 'test' });
  expect(html).toContain('a &lt; b\nsecond');
  expect(html).toContain('color:#18212a;background-color:#ffffff');
  expect(html).toContain('font-size:9pt');
  expect(() => mailEditableDocument(undefined, '', 'empty', '')).toThrow('Write a reply');
});

test('reply serialization preserves 12px as points without changing the live draft or other sizes', () => {
  withMailWindow(window => {
    const doc = window.document;
    doc.body.style.fontSize = '12px';
    doc.body.innerHTML = 'Bare text<p id="default">Default <b>Bold</b></p>'
      + '<p id="formatted"><b><i><u>Formatted</u></i></b></p>'
      + '<p id="large" style="font-size:24px">Large</p><blockquote><p id="quoted">Quoted</p></blockquote>';
    const before = doc.documentElement.outerHTML;
    const result = serializeReplyDocument(doc as unknown as Document);
    const saved = new window.DOMParser().parseFromString(result, 'text/html');
    expect(doc.documentElement.outerHTML).toBe(before);
    expect(saved.body.textContent).toBe(doc.body.textContent);
    for (const selector of ['body > span', '#default', 'b', '#formatted', '#formatted u', '#quoted']) {
      expect(saved.querySelector(selector)!.getAttribute('style')).toContain('font-size: 9pt');
    }
    expect(saved.querySelector('#large')!.getAttribute('style')).toBe('font-size:24px');
  });
});

test('formatted sends add color defaults without changing authored styles or the text fallback', () => {
  withMailWindow(window => {
    const html = '<html style="color:#eeeeee"><head><style>body{background:#203040}</style></head>'
      + '<body style="color:#abcdef"><p style="color:#c02030;background-color:#f4e59a">Exact colors</p></body></html>';
    const editable = mailEditableDocument(html, '', 'colors', '');
    const apply = () => editable.apply({ ...editable.request, model: 'test' });
    apply();
    const result = apply();
    const doc = new window.DOMParser().parseFromString(result.html, 'text/html');
    expect(result.body).toBe('Exact colors');
    expect(doc.head.querySelectorAll('style[data-cheshi-mail-colors]')).toHaveLength(1);
    const references = doc.body.querySelectorAll('span[data-cheshi-mail-color-reference]');
    expect(references).toHaveLength(1);
    expect(references[0]!.textContent).toBe('\u00a0');
    expect(doc.head.firstElementChild?.textContent).toContain(':where(html){color:#eeeeee;background-color:#ffffff}');
    expect(doc.head.firstElementChild?.textContent).toContain(':where(body){color:#abcdef;background-color:inherit}');
    expect(doc.head.lastElementChild?.textContent).toBe('body{background:#203040}');
    expect(doc.documentElement.getAttribute('style')).toBe('color:#eeeeee');
    expect(doc.body.getAttribute('style')).toBe('color:#abcdef');
    expect(doc.querySelector('p')!.getAttribute('style')).toBe('color:#c02030;background-color:#f4e59a');
  });
});

test('legacy body colors remain stronger than defaults and invalid values cannot inject CSS', () => {
  withMailWindow(window => {
    const doc = new window.DOMParser().parseFromString('<body text="#fedcba" bgcolor="#123456"><p>Legacy</p></body>', 'text/html');
    applyMailDocumentColors(doc as unknown as Document);
    expect(doc.head.firstElementChild?.textContent).toContain(':where(body){color:#fedcba;background-color:#123456}');
    doc.body.setAttribute('text', 'red; display:none');
    doc.body.setAttribute('bgcolor', '</style><script>bad()</script>');
    applyMailDocumentColors(doc as unknown as Document);
    expect(doc.body.querySelectorAll('span[data-cheshi-mail-color-reference]')).toHaveLength(1);
    expect(doc.head.firstElementChild?.textContent).toContain(':where(body){color:inherit;background-color:inherit}');
    expect(doc.querySelector('script')).toBeNull();
  });
});
