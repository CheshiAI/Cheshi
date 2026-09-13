import { expect, test } from 'bun:test';
import { parseShowcaseAction, parseShowcaseState, parseShowcaseViewRequest, safeShowcaseUrl, SHOWCASE_URLS } from '../shared/showcase.ts';

const request = { page: 'gallery' as const, visible: true, bounds: { x: 320.5, y: 60, width: 800, height: 600 } };

test('view requests preserve fractional bounds while rejecting malformed visibility and dimensions', () => {
  expect(parseShowcaseViewRequest(request)).toEqual(request);
  expect(parseShowcaseViewRequest({ ...request, visible: false }).visible).toBe(false);
  for (const value of [null, [], { ...request, page: 'account' }, { ...request, visible: 1 },
    { ...request, visible: 'false' }, { ...request, bounds: null },
    ...[NaN, Infinity, -1, 100_001, '800'].map(width => ({ ...request, bounds: { ...request.bounds, width } }))]) {
    expect(() => parseShowcaseViewRequest(value)).toThrow();
  }
});

test('background colors accept only opaque six digit hex values and stay optional', () => {
  expect(Object.hasOwn(parseShowcaseViewRequest(request), 'backgroundColor')).toBe(false);
  for (const backgroundColor of ['#1E2025', '#aBcDeF', '#000000']) {
    expect(parseShowcaseViewRequest({ ...request, backgroundColor }).backgroundColor).toBe(backgroundColor);
  }
  for (const backgroundColor of [undefined, null, true, 123456, '#123', '#12345678', 'red',
    'rgb(30, 32, 37)', ' #1E2025 ', '#123456\n', '#1e2025; color: red', '#gggggg']) {
    expect(() => parseShowcaseViewRequest({ ...request, backgroundColor })).toThrow('Invalid Showcase background color.');
  }
});

test('only known navigation actions cross the bridge', () => {
  for (const action of ['back', 'forward', 'reload', 'home', 'external'] as const) expect(parseShowcaseAction(action)).toBe(action);
  for (const action of ['', 'executeJavaScript', 'https://example.com', null, {}]) {
    expect(() => parseShowcaseAction(action)).toThrow();
  }
});

test('navigation accepts secure public site links and rejects native protocols and embedded credentials', () => {
  expect(safeShowcaseUrl(SHOWCASE_URLS.gallery)).toBe(SHOWCASE_URLS.gallery);
  expect(safeShowcaseUrl('https://example.com/demo?q=one#section')).toBe('https://example.com/demo?q=one#section');
  for (const url of ['javascript:alert(1)', 'file:///tmp/demo', 'http://example.com', 'data:text/html,test',
    'cheshi://open', 'https://name:password@example.com', 'https://name@example.com', 'not a url', null]) {
    expect(safeShowcaseUrl(url)).toBeNull();
  }
});

test('state delivery validates the site address and literal status flags', () => {
  const state = { page: 'submission' as const, url: SHOWCASE_URLS.submission, title: 'Submit project',
    loading: false, error: null, canGoBack: false, canGoForward: true };
  expect(parseShowcaseState(state)).toEqual(state);
  expect(parseShowcaseState({ ...state, url: '' }).url).toBe('');
  for (const change of [{ url: 'file:///etc/passwd' }, { title: null }, { loading: 0 },
    { error: {} }, { canGoBack: 'false' }, { canGoForward: null }]) {
    expect(() => parseShowcaseState({ ...state, ...change })).toThrow();
  }
});
