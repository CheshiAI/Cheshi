import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DISABLE_DEVTOOLS_LIVE_METRICS, installDevelopmentDevTools } from '../lib/development-devtools.mts';

class Contents extends EventEmitter {
  url = 'devtools://devtools/bundled/devtools_app.html';
  destroyed = false;
  scripts: string[] = [];
  fail = false;
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  async executeJavaScript(script: string) {
    this.scripts.push(script);
    if (this.fail) throw new Error('DevTools API changed');
  }
}

function fixture(isPackaged = false) {
  const app = Object.assign(new EventEmitter(), { isPackaged });
  const errors: unknown[] = [];
  // The fake supplies only the events used at the Electron boundary.
  const dispose = installDevelopmentDevTools(app as unknown as Parameters<typeof installDevelopmentDevTools>[0],
    error => errors.push(error));
  const create = () => {
    const contents = new Contents();
    app.emit('web-contents-created', {}, contents);
    return contents;
  };
  return { app, create, dispose, errors };
}

test('packaged apps do not register a DevTools adapter', () => {
  const state = fixture(true);
  assert.equal(state.app.listenerCount('web-contents-created'), 0);
  const contents = state.create();
  contents.emit('dom-ready');
  assert.deepEqual(contents.scripts, []);
  state.dispose();
});

test('development adapter targets only bundled DevTools and survives reload and reopening', () => {
  const state = fixture();
  const contents = state.create();
  for (const url of ['http://127.0.0.1:5173/', 'about:srcdoc', 'https://example.test/', 'devtools://other/bundled/']) {
    contents.url = url;
    contents.emit('dom-ready');
  }
  assert.deepEqual(contents.scripts, []);
  contents.url = 'devtools://devtools/bundled/devtools_app.html';
  contents.emit('dom-ready');
  contents.emit('dom-ready');
  assert.deepEqual(contents.scripts, [DISABLE_DEVTOOLS_LIVE_METRICS, DISABLE_DEVTOOLS_LIVE_METRICS]);
  contents.destroyed = true;
  contents.emit('destroyed');
  assert.equal(contents.listenerCount('dom-ready'), 0);
  const reopened = state.create();
  reopened.emit('dom-ready');
  assert.equal(reopened.scripts.length, 1);
  state.app.emit('will-quit');
  assert.equal(reopened.listenerCount('dom-ready'), 0);
  assert.equal(state.app.listenerCount('web-contents-created'), 0);
  state.dispose();
});

test('API failures are reported, while closing DevTools cancels stale failure reporting', async () => {
  const state = fixture();
  const contents = state.create();
  contents.fail = true;
  contents.emit('dom-ready');
  await Promise.resolve();
  assert.equal(state.errors.length, 1);
  assert.match(String(state.errors[0]), /DevTools API changed/);
  contents.emit('dom-ready');
  contents.destroyed = true;
  contents.emit('destroyed');
  await Promise.resolve();
  assert.equal(state.errors.length, 1);
  state.dispose();
});
