import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { strictEqual, ok } from 'node:assert/strict';
import { AUTOPILOT_PAGE_SCRIPT, parseAutopilotPage } from '../lib/autopilot-page.mts';
import { executeAutopilotInput } from '../lib/autopilot-input.mts';
import { performAutopilotInteraction } from '../lib/autopilot-interaction.mts';
import type { AutopilotPage } from '../lib/autopilot-model.mts';
import type { AutopilotInteraction } from '../lib/autopilot-actions.mts';

const directory = process.env.CHESHI_AUTOPILOT_TEST_DATA;
if (!directory) throw new Error('An isolated test data directory is required.');
app.setPath('userData', directory);
app.commandLine.appendSwitch('disable-gpu');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>Input fixture</title></head><body><main></main></body></html>');
});

async function rejects(operation: Promise<unknown>, pattern: RegExp) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  ok(failure instanceof Error && pattern.test(failure.message), `Expected ${pattern}, received ${failure}`);
}

async function run() {
  await app.whenReady();
  app.dock?.hide();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address.');
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const contents = window.webContents;
  const controller = new AbortController();
  const signal = controller.signal;
  try {
    await contents.loadURL(`http://127.0.0.1:${address.port}/`);
    const evaluate = (code: string) => contents.executeJavaScriptInIsolatedWorld(1002, [{ code }], true);
    const script = (code: string) => contents.executeJavaScript(code);
    const read = async () => parseAutopilotPage(await evaluate(AUTOPILOT_PAGE_SCRIPT));
    const setMarkup = (markup: string) => script(`document.querySelector('main').innerHTML = ${JSON.stringify(markup)}`);
    const options = { evaluate, read, loading: () => contents.isLoadingMainFrame(),
      execute: (page: AutopilotPage, action: AutopilotInteraction, signal: AbortSignal, dispatched: () => void) =>
        executeAutopilotInput({ debugger: contents.debugger, evaluate }, page, action, signal, dispatched),
      pollMs: 20, settleMs: 60, timeoutMs: 1500 };

    await setMarkup('<form><label for="origin">Origin</label><input id="origin" value="부산">'
      + '<label for="destination">Destination</label><input id="destination" value="old text"><button>Search</button></form>');
    await script(`globalThis.trustedInputs = []; document.querySelector('#destination').addEventListener('input', event => {
      trustedInputs.push(event.isTrusted);
      const old = event.target;
      queueMicrotask(() => { const next = old.cloneNode(); next.value = old.value; old.replaceWith(next); });
    });`);
    let before = await read();
    const destination = before.controls!.find(control => control.label === 'Destination')!;
    let sent = 0;
    let after = await performAutopilotInteraction(options, before, { kind: 'fill', control: destination, text: '서울 Zürich 🐈' }, signal, () => sent++);
    strictEqual(after.controls!.find(control => control.label === 'Destination')!.value, '서울 Zürich 🐈');
    strictEqual(after.controls!.find(control => control.label === 'Origin')!.value, '부산');
    strictEqual(await script('trustedInputs.length === 1 && trustedInputs[0] === true'), true);
    strictEqual(sent, 1);
    ok(after.controls!.find(control => control.label === 'Destination')!.id !== destination.id, 'Controlled input replaced its DOM node');

    // A different field changed after the decision: do not submit an outdated form.
    before = await read();
    const submit = before.controls!.find(control => control.kind === 'button')!;
    await script(`document.querySelector('#origin').value = '인천'; globalThis.clicks = 0;
      document.querySelector('button').addEventListener('click', event => { event.preventDefault(); clicks++; });`);
    await rejects(performAutopilotInteraction(options, before, { kind: 'click', control: submit }, signal), /page changed/);
    strictEqual(await script('clicks'), 0);

    // Correct target, but an overlay now receives the click.
    before = await read();
    await script(`const overlay = document.createElement('div'); overlay.id='overlay';
      overlay.style.cssText='position:fixed;inset:0;z-index:10000;background:white'; document.body.append(overlay);`);
    await rejects(performAutopilotInteraction(options, before, { kind: 'click', control: before.controls!.find(control => control.kind === 'button')! }, signal), /covered or unavailable/);
    strictEqual(await script('clicks'), 0);
    await script('document.querySelector("#overlay").remove()');

    // Unrelated live text does not invalidate the same button or its unchanged form values.
    await setMarkup('<section><span id="clock">09:00</span><button id="stable">Search</button><output></output></section>');
    await script(`document.querySelector('button').addEventListener('click', event => {
      document.querySelector('output').textContent = event.isTrusted ? 'Results loaded' : 'Untrusted click';
    });`);
    before = await read();
    await script(`document.querySelector('#clock').textContent = '09:01';`);
    after = await performAutopilotInteraction(options, before, { kind: 'click', control: before.controls![0]! }, signal);
    ok(after.text.includes('Results loaded'), 'Changing surrounding text does not make a valid control stale');

    // A small overlay covers only the center. A visible part of the same control remains clickable.
    await setMarkup('<button id="partial" style="width:200px;height:50px">Open results</button><output></output>');
    await script(`const rect=document.querySelector('button').getBoundingClientRect();
      const cover=document.createElement('div'); cover.style.cssText='position:fixed;z-index:10;width:20px;height:20px;background:white;pointer-events:auto';
      cover.style.left=(rect.x+rect.width/2-10)+'px'; cover.style.top=(rect.y+rect.height/2-10)+'px'; document.querySelector('main').append(cover);
      document.querySelector('button').addEventListener('click', () => document.querySelector('output').textContent='Partial target clicked');`);
    before = await read();
    after = await performAutopilotInteraction(options, before, { kind: 'click', control: before.controls![0]! }, signal);
    ok(after.text.includes('Partial target clicked'));

    await setMarkup('<div style="height:1600px"></div><button>Below viewport</button><output></output>');
    await script(`document.documentElement.style.scrollBehavior='smooth'; window.scrollTo({top:0,behavior:'instant'});
      document.querySelector('button').addEventListener('click', () => document.querySelector('output').textContent='Scrolled and clicked');`);
    before = await read();
    after = await performAutopilotInteraction(options, before, { kind: 'click', control: before.controls![0]! }, signal);
    ok(after.text.includes('Scrolled and clicked'), 'Native target preparation overrides smooth scrolling');
    await script(`document.documentElement.style.scrollBehavior='auto'; window.scrollTo({top:0,behavior:'instant'});`);

    // A focus handler replaces the observed field. No text may reach either node.
    await setMarkup('<input id="focus" aria-label="Destination" value="unchanged">');
    await script(`document.querySelector('#focus').addEventListener('focus', event => event.target.replaceWith(event.target.cloneNode()), {once:true});`);
    before = await read();
    await rejects(performAutopilotInteraction(options, before, { kind: 'fill', control: before.controls![0]!, text: 'wrong target' }, signal), /page changed/);
    strictEqual(await script('document.querySelector("input").value'), 'unchanged');

    await setMarkup('<input id="city" aria-label="Destination" role="combobox" aria-controls="cities"><div id="cities" role="listbox"></div>');
    await script(`document.querySelector('#city').addEventListener('focus', event => event.target.setAttribute('aria-expanded', 'true'));
    document.querySelector('#city').addEventListener('input', () => setTimeout(() => {
      document.querySelector('#cities').innerHTML='<div role="option" tabindex="0">서울, 대한민국</div>';
      document.querySelector('[role=option]').addEventListener('click', () => {
        document.querySelector('#city').value='서울, 대한민국'; document.querySelector('#cities').replaceChildren();
      });
    }, 150));`);
    before = await read();
    after = await performAutopilotInteraction(options, before, { kind: 'fill', control: before.controls![0]!, text: '서울' }, signal);
    const suggestion = after.controls!.find(control => control.role === 'option');
    ok(suggestion, 'Waited for the autocomplete suggestion');
    after = await performAutopilotInteraction(options, after, { kind: 'click', control: suggestion }, signal);
    strictEqual(after.controls![0]!.value, '서울, 대한민국');

    // A framework rejects native input. An input event alone is not success and is not replayed.
    await setMarkup('<input aria-label="Search" type="search" value="old">');
    await script(`globalThis.inputCount = 0; document.querySelector('input').addEventListener('input', event => {
      inputCount++; queueMicrotask(() => { event.target.value='old'; });
    });`);
    before = await read();
    await rejects(performAutopilotInteraction({ ...options, timeoutMs: 250 }, before,
      { kind: 'fill', control: before.controls![0]!, text: 'new' }, signal), /did not retain/);
    strictEqual(await script('inputCount'), 1);
    process.stdout.write('AUTOPILOT_INPUT_OK\n');
  } finally { window.destroy(); server.close(); }
}

void run().then(() => app.quit(), error => { process.stderr.write(String(error.stack ?? error)); server.close(); app.exit(1); });
setTimeout(() => app.exit(2), 25000).unref();
