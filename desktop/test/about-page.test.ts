import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { aboutPage } from '../lib/about-page.mts';

test('shows version and build independently with the supplied logo', () => {
  const page = aboutPage({ name: 'Cheshi', version: '0.0.1-preview', buildNumber: '2', publisher: 'Cheshi', year: 2026 });
  assert.match(page, /<dt>Version<\/dt><dd>0\.0\.1-preview<\/dd>/u);
  assert.match(page, /<dt>Build<\/dt><dd>0002<\/dd>/u);
  assert.match(page, /© 2026 Cheshi/u);
  const logo = readFileSync(new URL('../../resources/icons/about-logo.png', import.meta.url)).toString('base64');
  assert.ok(page.includes(`src="data:image/png;base64,${logo}"`));
});

test('escapes product metadata inside the isolated page', () => {
  const page = aboutPage({ name: '<script>alert(1)</script>', version: '"&', buildNumber: '<2>', publisher: "O'Reilly" });
  assert.doesNotMatch(page, /<script>/u);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(page, /<dd>&quot;&amp;<\/dd>/u);
  assert.match(page, /<dd>&lt;2&gt;<\/dd>/u);
  assert.match(page, /O&#39;Reilly/u);
  assert.match(page, /default-src 'none'/u);
});
