import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mailEditableDocument } from '../frontend/src/features/mail/mailEditableDocument';

test('only authored text changes; HTML, image data, attributes, quotes and signatures are retained', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = new Window();
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  try {
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
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
    void window.happyDOM.abort();
  }
});
test('plain replies become escaped HTML and empty authored replies cannot send only a quotation', () => {
  const editable = mailEditableDocument(undefined, 'a < b\nsecond', 'plain', '');
  expect(editable.apply({ ...editable.request, model: 'test' }).html).toContain('a &lt; b\nsecond');
  expect(() => mailEditableDocument(undefined, '', 'empty', '')).toThrow('Write a reply');
});
