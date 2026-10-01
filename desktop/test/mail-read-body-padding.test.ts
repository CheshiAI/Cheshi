import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { applyMailReadBodyPadding } from '../frontend/src/features/mail/mailReadBodyPadding';

function withBody(html: string, check: (body: HTMLElement) => void) {
  const window = new Window();
  window.document.body.innerHTML = html;
  try { check(window.document.body as unknown as HTMLElement); }
  finally { void window.happyDOM.abort(); }
}

test('reading padding separates authored text and preserves the whole quoted subtree', () => {
  withBody('<p style="font-size:18px;color:#c02030">Reply</p><p>Second paragraph</p>'
    + '<blockquote type="cite" style="padding-left:12px"><p>Original</p>'
    + '<blockquote type="cite" style="padding:inherit">Earlier reply</blockquote></blockquote>', body => {
    const quote = body.querySelector('blockquote')!;
    const originalQuote = quote.outerHTML;
    const originalText = body.textContent;
    applyMailReadBodyPadding(body);
    expect(body.children).toHaveLength(2);
    expect(body.firstElementChild?.textContent).toBe('ReplySecond paragraph');
    expect(body.firstElementChild?.querySelector('p')?.getAttribute('style')).toBe('font-size:18px;color:#c02030');
    expect(quote.parentElement).toBe(body);
    expect(quote.outerHTML).toBe(originalQuote);
    expect(body.textContent).toBe(originalText);
    const once = body.outerHTML;
    applyMailReadBodyPadding(body);
    expect(body.outerHTML).toBe(once);
  });
});

test('quotations inside layout containers stay outside every padded authored run', () => {
  withBody('<div><table><tbody><tr><td><p>Reply</p><blockquote type="cite"><p>Original</p></blockquote>'
    + '<p>After quote</p></td><td><p>Side note</p></td></tr></tbody></table></div>', body => {
    const quote = body.querySelector('blockquote')!;
    const parent = quote.parentElement;
    const originalQuote = quote.outerHTML;
    applyMailReadBodyPadding(body);
    expect(quote.outerHTML).toBe(originalQuote);
    expect(quote.parentElement).toBe(parent);
    expect(quote.closest('[data-cheshi-mail-read-padding]')).toBeNull();
    expect(body.querySelectorAll('tr > td')).toHaveLength(2);
    expect(body.querySelectorAll('td > [data-cheshi-mail-read-padding]')).toHaveLength(3);
    expect(body.querySelector('table')?.parentElement?.tagName).toBe('DIV');
  });
});

test('interleaved reply text keeps its order between multiple quotations', () => {
  withBody('First <b>reply</b><blockquote type="cite">One</blockquote>Second reply'
    + '<blockquote type="cite">Two</blockquote>Last reply', body => {
    const text = body.textContent;
    const quotes = [...body.querySelectorAll('blockquote')].map(quote => quote.outerHTML);
    applyMailReadBodyPadding(body);
    expect(body.textContent).toBe(text);
    expect([...body.querySelectorAll('blockquote')].map(quote => quote.outerHTML)).toEqual(quotes);
    expect(body.querySelectorAll('[data-cheshi-mail-read-padding]')).toHaveLength(3);
    expect([...body.children].map(child => child.textContent)).toEqual(['First reply', 'One', 'Second reply', 'Two', 'Last reply']);
  });
});

test('plain bodies retain a single inset while quote-only messages gain none', () => {
  withBody('Bare text<p>Paragraph</p><ul><li>List</li></ul>', body => {
    const html = body.innerHTML;
    applyMailReadBodyPadding(body);
    expect(body.children).toHaveLength(1);
    expect(body.firstElementChild?.innerHTML).toBe(html);
  });
  withBody(' \n<blockquote type="cite"><p>Only original</p></blockquote>\n ', body => {
    const html = body.innerHTML;
    applyMailReadBodyPadding(body);
    expect(body.innerHTML).toBe(html);
  });
});
