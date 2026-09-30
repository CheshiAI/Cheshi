import { expect, test } from 'bun:test';
import { withMailHtml, mailSource } from '../lib/apple-mail-mime.mts';
import { AppleMailService } from '../lib/apple-mail-service.mts';
import { createAppleMailApi } from '../lib/apple-mail-preload.cts';
import { MAIL_BODY_LIMIT, MAIL_SOURCE_LIMIT, MAIL_INLINE_IMAGE_LIMIT, mailMessage } from '../shared/apple-mail';
import { mailBox, mailMessageFixture as message, mailSuccess } from './apple-mail-fixtures';

const html = '<html><head><style>h1{color:navy}</style></head><body><h1>안녕하세요</h1><img src="cid:logo@example.test"><a href="https://example.test">Read more</a></body></html>';
const image = { contentId: 'logo@example.test', mimeType: 'image/png', base64: 'aGVsbG8=' };
function part(type: string, content: string, headers = '') {
  return `Content-Type: ${type}\r\n${headers}\r\n${content}\r\n`;
}
function multipart(type: string, boundary: string, parts: string[]) {
  return part(`${type}; boundary="${boundary}"`, parts.map(value => `--${boundary}\r\n${value}`).join('') + `--${boundary}--`);
}
const source = multipart('multipart/related', 'outer', [
  multipart('multipart/alternative', 'inner', [
    part('text/plain; charset=utf-8', 'Plain text'),
    part('text/html; charset=utf-8', Buffer.from(html).toString('base64'), 'Content-Transfer-Encoding: base64\r\n'),
  ]),
  part('image/png', image.base64, 'Content-ID: <logo@example.test>\r\nContent-Transfer-Encoding: base64\r\n'),
  part('image/svg+xml', '<svg/>', 'Content-ID: <unsupported>\r\n'),
  part('image/png', '', 'Content-ID: <empty>\r\nContent-Transfer-Encoding: base64\r\n'),
  part('application/pdf', 'attachment', 'Content-Disposition: attachment; filename="report.pdf"\r\n'),
]);

test('MIME preserves HTML, charset and related inline images without forwarding unrelated attachments', async () => {
  const result = await withMailHtml(message, source);
  expect(result.html?.trim()).toBe(html);
  expect(result.inlineImages).toEqual([image]);
  expect(result.body).toBe(message.body);
  expect(mailMessage(result, message.id)).toEqual(result);
});

test('quoted-printable HTML decodes legacy charsets and strips NUL characters', async () => {
  const result = await withMailHtml(message, part('text/html; charset=iso-8859-1', '<p>Caf=E9=00</p>', 'Content-Transfer-Encoding: quoted-printable\r\n'));
  expect(result.html?.trim()).toBe('<p>Café</p>');
});

test('missing, oversized, malformed and text-only MIME preserve the existing plain text', async () => {
  let nested = part('text/html', '<h1>Nested</h1>');
  for (let i = 0; i < 40; i++) nested = multipart('multipart/mixed', `b${i}`, [nested]);
  for (const raw of [null, '', 'not a MIME message', part('text/plain', '<h1>Literal</h1>'),
    part('text/html', 'x'.repeat(MAIL_BODY_LIMIT + 1)), 'x'.repeat(MAIL_SOURCE_LIMIT + 1), nested]) {
    expect(await withMailHtml(message, raw)).toBe(message);
  }
  expect(mailSource(null)).toBeNull();
  expect(mailSource({ source: 10 })).toBeNull();
  expect(mailSource({ source: '한'.repeat(MAIL_SOURCE_LIMIT / 2) })).toBeNull();
  expect(mailSource({ source })).toBe(source);
});

test('service and preload deliver HTML and images, never raw MIME', async () => {
  const service = new AppleMailService({ platform: 'darwin', execute: async () => JSON.stringify(mailSuccess({ ...message, source })) });
  const api = createAppleMailApi({ invoke: async (_channel: string, ...args: unknown[]) => service.read(args[0]) }, 'darwin');
  const reply = await api.read({ mailbox: mailBox, id: message.id });
  expect(reply.ok).toBe(true);
  if (!reply.ok) throw new Error('Expected HTML mail');
  expect(reply.value.html?.trim()).toBe(html);
  expect(reply.value.inlineImages).toEqual([image]);
  expect(Object.hasOwn(reply.value, 'source')).toBe(false);
});

test('inline-image boundary rejects unsupported types, duplicates, malformed data and excessive payloads', () => {
  for (const images of [[{ ...image, mimeType: 'image/svg+xml' }], [image, image],
    [{ ...image, base64: 'bad!' }], [{ ...image, base64: 'a===' }], [{ ...image, base64: 'YQ=' }],
    [{ ...image, base64: 'a'.repeat(MAIL_INLINE_IMAGE_LIMIT + 4) }],
    Array.from({ length: 33 }, (_, i) => ({ ...image, contentId: String(i) }))]) {
    expect(() => mailMessage({ ...message, html, inlineImages: images }, message.id)).toThrow();
  }
  const large = { ...image, base64: 'a'.repeat(MAIL_INLINE_IMAGE_LIMIT) };
  expect(mailMessage({ ...message, inlineImages: [large] }, message.id).inlineImages?.[0]?.base64.length).toBe(MAIL_INLINE_IMAGE_LIMIT);
});

test('duplicate CIDs and excess inline images are bounded without losing the HTML body', async () => {
  const images = Array.from({ length: 35 }, (_, i) => part('image/png', image.base64,
    `Content-ID: <image${i}>\r\nContent-Transfer-Encoding: base64\r\n`));
  const result = await withMailHtml(message, multipart('multipart/related', 'many', [part('text/html', html), images[0]!, ...images]));
  expect(result.html?.trim()).toBe(html);
  expect(result.inlineImages).toHaveLength(32);
  expect(new Set(result.inlineImages?.map(value => value.contentId)).size).toBe(32);
});
