import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceView } from '../frontend/src/features/voice/VoiceView';
import type { ChatWorkspace } from '../frontend/src/features/chat/ChatWorkspace';
import type { SidebarRail } from '../frontend/src/features/navigation/SidebarRail';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import { splitPaneIds } from '../frontend/src/shared/ui/splitPaneModel';
import { elements, props, shellHarness } from './workspace-shell-test-harness';
import type { VoiceRecordingsApi } from '../shared/voice-recordings';
import type { VoiceRecordingsSnapshot } from '../shared/voice-recordings';
import type { SettingsView } from '../frontend/src/features/settings/SettingsView';
import type { VoiceDetailApi } from '../shared/voice-transcription';

async function withVoice(run: (h: {
  button(label: string): HTMLButtonElement;
  click(label: string): Promise<void>;
  escape(target: HTMLElement, options?: { composing?: boolean; prevented?: boolean }): Promise<boolean>;
  panel(): HTMLElement;
  outside(): HTMLInputElement;
}) => Promise<void>, api: VoiceRecordingsApi = { list: async () => ({ status: 'ready', recordings: [], truncated: false }) }, onOpenSettings?: () => void) {
  const window = new Window();
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const value = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!value) throw new Error(`Missing button: ${label}`);
    return value;
  };
  try {
    await act(async () => root.render(<><VoiceView recordingsApi={api} onOpenSettings={onOpenSettings} /><input aria-label="Unrelated input" /></>));
    await run({ button,
      click: async label => { await act(async () => { button(label).focus(); button(label).click(); }); },
      panel: () => document.getElementById(button('Recordings').getAttribute('aria-controls')!)!.parentElement!,
      outside: () => container.querySelector('input')!,
      escape: async (target, { composing = false, prevented = false } = {}) => {
        const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: composing });
        if (prevented) event.preventDefault();
        await act(async () => { target.dispatchEvent(event as unknown as Event); });
        return event.defaultPrevented;
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('Voice recording list toggles, excludes collapsed content from interaction, and restores focus', async () => {
  await withVoice(async h => {
    expect(document.querySelector('main[aria-label="Voice workspace"] h2')?.textContent).toBe('VOICE');
    expect(h.panel().hasAttribute('inert')).toBe(true);
    expect(h.panel().getAttribute('aria-hidden')).toBe('true');
    await h.click('Recordings');
    expect(h.button('Recordings').getAttribute('aria-expanded')).toBe('true');
    expect(h.panel().hasAttribute('inert')).toBe(false);
    expect(h.panel().textContent).toContain('No recordings yet.');
    await h.click('Recordings');
    expect(h.button('Recordings').getAttribute('aria-expanded')).toBe('false');
    await h.click('Recordings');
    await h.click('Close recordings panel');
    expect(h.panel().hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(h.button('Recordings'));
    await h.click('Recordings');
    expect(await h.escape(h.button('Recordings'))).toBe(true);
    expect(h.button('Recordings').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(h.button('Recordings'));
    expect(await h.escape(h.button('Recordings'))).toBe(false);
  });
});

test('Voice panel respects IME, handled Escape, and unrelated input', async () => {
  await withVoice(async h => {
    await h.click('Recordings');
    await h.escape(h.button('Close recordings panel'), { composing: true });
    await h.escape(h.button('Close recordings panel'), { prevented: true });
    expect(await h.escape(h.outside())).toBe(false);
    expect(h.button('Recordings').getAttribute('aria-expanded')).toBe('true');
    expect(await h.escape(h.button('Close recordings panel'))).toBe(true);
    expect(h.button('Recordings').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(h.button('Recordings'));
  });
});

test('Tools opens Voice, preserves an editor-only layout, and can return to SESSION', () => {
  const app = shellHarness(false, { panel: 'files' }, { type: 'pane', paneId: 'editor' });
  app.render();
  app.openTool('voice');
  const tree = app.render();
  expect(elements(tree).some(node => node.type === 'VoiceView')).toBe(true);
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(tree, 'WorkspaceEditorSplit');
  expect(splitPaneIds(split.layout!)).toEqual(['editor', 'primary']);
  expect(props<ComponentProps<typeof SidebarRail>>(tree, 'SidebarRail').activeView).toBe('voice');
  expect(props<ComponentProps<typeof ChatWorkspace>>(tree, 'ChatWorkspace').active).toBe(false);
  app.openTool('voice');
  expect(splitPaneIds(props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit').layout!))
    .toEqual(['editor', 'primary']);
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  expect(elements(app.render()).some(node => node.type === 'VoiceView')).toBe(false);
  expect(props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace').active).toBe(true);
});

test('Voice lists title, date and duration, then refreshes renamed recordings on focus', async () => {
  let title = '엘에스로116번길', requests = 0;
  const api: VoiceRecordingsApi = { list: async () => {
    requests++;
    return { status: 'ready', truncated: false, recordings: [{ id: 'memo', title, recordedAt: 1792022400000, durationSeconds: 817 }] };
  } };
  await withVoice(async h => {
    expect(requests).toBe(1);
    await h.click('Recordings');
    expect(h.panel().textContent).toContain('엘에스로116번길');
    expect(h.panel().textContent).toContain('13:37');
    expect(h.panel().querySelector('time')?.getAttribute('datetime')).toBe(new Date(1792022400000).toISOString());
    title = 'Renamed';
    await act(async () => { window.dispatchEvent(new window.Event('focus')); });
    expect(h.panel().textContent).toContain('Renamed');
    expect(h.panel().textContent).not.toContain('엘에스로116번길');
    await h.click('Refresh recordings');
    expect(requests).toBe(4);
  }, api);
});

test('Voice permission action opens Cheshi settings and retains manual refresh after permission changes', async () => {
  let denied = true;
  let opened = 0, reads = 0;
  await withVoice(async h => {
    await h.click('Recordings');
    expect(h.panel().textContent).toContain('Settings → Voice');
    expect(h.panel().textContent).not.toContain('No recordings yet.');
    expect(h.panel().textContent).not.toContain('Try again');
    const previousReads = reads;
    await h.click('Open Voice settings');
    expect(opened).toBe(1);
    expect(reads).toBe(previousReads);
    denied = false;
    await h.click('Refresh recordings');
    expect(h.panel().textContent).toContain('No recordings yet.');
    expect(h.panel().textContent).not.toContain('Settings → Voice');
  }, { list: async () => { reads++; return { status: denied ? 'permission-required' : 'ready', recordings: [], truncated: false }; },
    openFullDiskAccessSettings: async () => { throw new Error('Should navigate within Cheshi'); } }, () => { opened++; });
});

test('Voice ignores an older request finishing after a newer refresh', async () => {
  let resolveOld!: (value: VoiceRecordingsSnapshot) => void;
  const old = new Promise<VoiceRecordingsSnapshot>(resolve => { resolveOld = resolve; });
  let calls = 0;
  await withVoice(async h => {
    await h.click('Recordings');
    expect(h.panel().textContent).toContain('No recordings yet.');
    await act(async () => { resolveOld({ status: 'permission-required', recordings: [], truncated: false }); });
    expect(h.panel().textContent).not.toContain('Settings → Voice');
  }, { list: () => ++calls === 1 ? old : Promise.resolve({ status: 'ready', recordings: [], truncated: false }) });
});

test('Voice keeps retry for ordinary load failures', async () => {
  let failed = true;
  await withVoice(async h => {
    await h.click('Recordings');
    expect(h.panel().querySelector('[aria-label="Open Voice settings"]')).toBeNull();
    failed = false;
    const retry = [...h.panel().querySelectorAll('button')].find(button => button.textContent === 'Try again')!;
    await act(async () => { retry.click(); });
    expect(h.panel().textContent).toContain('No recordings yet.');
  }, { list: async () => ({ status: failed ? 'unavailable' : 'ready', recordings: [], truncated: false }) });
});

test('recording selection is exclusive, survives refresh by id and clears when the recording disappears', async () => {
  let recordings = [
    { id: 'first', title: 'First', recordedAt: 1000, durationSeconds: 817 },
    { id: 'second', title: 'Second', recordedAt: 2000, durationSeconds: 65 },
  ];
  await withVoice(async h => {
    await h.click('Recordings');
    const rows = () => [...h.panel().querySelectorAll<HTMLButtonElement>('ul button[aria-pressed]')];
    const selected = () => rows().filter(row => row.getAttribute('aria-pressed') === 'true');
    expect(selected()).toHaveLength(0);
    await act(async () => rows()[0]!.click());
    expect(selected()).toHaveLength(1);
    expect(selected()[0]!.textContent).toContain('First');
    await act(async () => rows()[1]!.click());
    expect(selected()).toHaveLength(1);
    expect(selected()[0]!.textContent).toContain('Second');
    recordings = [{ ...recordings[1]!, title: 'Renamed' }, recordings[0]!];
    await h.click('Refresh recordings');
    expect(selected()).toHaveLength(1);
    expect(selected()[0]!.textContent).toContain('Renamed');
    await h.click('Close recordings panel');
    await h.click('Recordings');
    expect(selected()).toHaveLength(1);
    recordings = [recordings[1]!];
    await h.click('Refresh recordings');
    expect(selected()).toHaveLength(0);
  }, { list: async () => ({ status: 'ready', recordings, truncated: false }) });
});

test('Voice settings navigation selects Voice directly, preserves panes and leaves normal settings entry unchanged', () => {
  const app = shellHarness(false, { panel: 'files' }, { type: 'pane', paneId: 'editor' });
  app.render();
  app.openTool('voice');
  const voiceTree = app.render();
  const layout = props<ComponentProps<typeof WorkspaceEditorSplit>>(voiceTree, 'WorkspaceEditorSplit').layout;
  props<ComponentProps<typeof VoiceView>>(voiceTree, 'VoiceView').onOpenSettings!();
  const settingsTree = app.render();
  expect(props<ComponentProps<typeof SidebarRail>>(settingsTree, 'SidebarRail').activeView).toBe('settings');
  expect(props<ComponentProps<typeof SettingsView>>(settingsTree, 'SettingsView').initialCategory).toBe('voice');
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(settingsTree, 'WorkspaceEditorSplit').layout).toEqual(layout);
  app.openTool('voice');
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('settings');
  expect(props<ComponentProps<typeof SettingsView>>(app.render(), 'SettingsView').initialCategory).toBe('agents');
});

function detailFixture(overrides: Partial<VoiceDetailApi> = {}): VoiceDetailApi {
  return {
    openAudio: async id => `cheshi-voice://recording/${id}`, releaseAudio: async () => {},
    waveform: async () => ({ duration: 30, peaks: [0.1, 0.5, 0.2] }), saveAudio: async () => 'cancelled',
    capabilities: async () => ({ available: true, languages: [{ id: 'en-US', name: 'English', installed: true }] }),
    transcribe: async () => {}, cancelTranscription: async () => {},
    transcription: async () => ({ status: 'complete', segments: [{ start: 2, end: 3, text: 'Hello from this recording.' }] }),
    ...overrides,
  };
}
const twoRecordings: VoiceRecordingsSnapshot = { status: 'ready', truncated: false, recordings: [
  { id: '1', title: 'First memo', recordedAt: 1000, durationSeconds: 30 },
  { id: '2', title: 'Second memo', recordedAt: 2000, durationSeconds: 60 },
] };
test('Voice displays English language names while preserving native transcription locale identifiers', async () => {
  const locales: string[] = [];
  await withVoice(async h => {
    await h.click('Recordings');
    await act(async () => h.panel().querySelector<HTMLButtonElement>('ul button')!.click());
    expect(h.button('Transcription language').textContent).toContain('English (United States)');
    await h.click('Transcription language');
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(options.map(option => option.textContent)).toEqual(['English (United States)', 'Korean (South Korea)']);
    await act(async () => options[1]!.click());
    expect(h.button('Transcription language').textContent).toContain('Korean (South Korea)');
    await h.click('Transcribe recording');
    expect(locales).toEqual(['ko_KR']);
  }, { list: async () => twoRecordings, detail: detailFixture({
    capabilities: async () => ({ available: true, languages: [
      { id: 'en-US', name: '영어(미국)', installed: true },
      { id: 'ko_KR', name: '한국어(대한민국)', installed: true },
    ] }),
    transcribe: async (_id, locale) => { locales.push(locale); },
  }) });
});
test('selected recording provides playback controls and explicit transcription with time seeking', async () => {
  const starts: string[] = [], releases: string[] = [];
  await withVoice(async h => {
    await h.click('Recordings');
    await act(async () => h.panel().querySelector<HTMLButtonElement>('ul button')!.click());
    const audio = document.querySelector<HTMLAudioElement>('audio[aria-label="Recording playback"]')!;
    expect(audio.getAttribute('src')).toBe('cheshi-voice://recording/1');
    expect(audio.hasAttribute('controls')).toBe(false);
    expect(h.button('Play recording')).toBeDefined();
    expect(audio.hasAttribute('autoplay')).toBe(false);
    expect(starts).toHaveLength(0);
    await h.click('Transcribe recording');
    expect(starts).toEqual(['1']);
    expect(document.querySelector('[aria-label="Transcription text"]')?.textContent).toContain('Hello from this recording.');
    await h.click('Seek to 0:02');
    expect(audio.currentTime).toBe(2);
    await act(async () => h.panel().querySelectorAll<HTMLButtonElement>('ul button')[1]!.click());
    expect(document.querySelector('[aria-label="Transcription text"]')?.textContent).not.toContain('Hello from this recording.');
    expect(releases).toContain('cheshi-voice://recording/1');
  }, { list: async () => twoRecordings, detail: detailFixture({
    transcribe: async id => { starts.push(id); }, releaseAudio: async url => { releases.push(url); },
  }) });
  expect(releases).toContain('cheshi-voice://recording/2');
});
test('selection cancels pending transcription and ignores stale audio and transcription responses', async () => {
  let resolveAudio!: (url: string) => void;
  const oldAudio = new Promise<string>(resolve => { resolveAudio = resolve; });
  let resolveTranscript!: (state: Awaited<ReturnType<VoiceDetailApi['transcription']>>) => void;
  const oldTranscript = new Promise<Awaited<ReturnType<VoiceDetailApi['transcription']>>>(resolve => { resolveTranscript = resolve; });
  const releases: string[] = [], cancelled: string[] = [];
  let opens = 0;
  await withVoice(async h => {
    await h.click('Recordings');
    const select = async (index: number) => { await act(async () => h.panel().querySelectorAll<HTMLButtonElement>('ul button')[index]!.click()); };
    await select(0); await select(1);
    await act(async () => resolveAudio('cheshi-voice://recording/old'));
    expect(releases).toContain('cheshi-voice://recording/old');
    expect(document.querySelector('audio')?.getAttribute('src')).toBe('cheshi-voice://recording/2');
    await h.click('Transcribe recording');
    expect(h.button('Transcribe recording').disabled).toBe(true);
    await select(0);
    expect(cancelled).toHaveLength(1);
    await act(async () => resolveTranscript({ status: 'complete', segments: [{ start: 0, end: 1, text: 'Stale transcript' }] }));
    expect(document.querySelector('[aria-label="Transcription text"]')?.textContent).not.toContain('Stale transcript');
  }, { list: async () => twoRecordings, detail: detailFixture({
    openAudio: id => ++opens === 1 ? oldAudio : Promise.resolve(`cheshi-voice://recording/${id}`),
    releaseAudio: async url => { releases.push(url); }, transcription: () => oldTranscript,
    cancelTranscription: async id => { cancelled.push(id); },
  }) });
});
test('audio failures can be retried and explicit cancel stops transcription', async () => {
  let failed = true, cancelled = 0;
  await withVoice(async h => {
    await h.click('Recordings');
    await act(async () => h.panel().querySelector<HTMLButtonElement>('ul button')!.click());
    expect(h.button('Transcribe recording').disabled).toBe(true);
    failed = false;
    await h.click('Retry recording');
    await h.click('Transcribe recording');
    await h.click('Cancel transcription');
    expect(cancelled).toBe(1);
    expect(document.querySelector('[aria-label="Recording details"]')?.textContent).toContain('Transcription cancelled.');
    expect(h.button('Transcribe recording').disabled).toBe(false);
  }, { list: async () => twoRecordings, detail: detailFixture({
    openAudio: async id => { if (failed) throw new Error('missing file'); return `cheshi-voice://recording/${id}`; },
    transcription: async () => ({ status: 'transcribing', segments: [] }),
    cancelTranscription: async () => { cancelled++; },
  }) });
});

test('transcript cards follow playback and seeking, clear between recordings, and keep information after the transcript', async () => {
  await withVoice(async h => {
    await h.click('Recordings');
    await act(async () => h.panel().querySelector<HTMLButtonElement>('ul button')!.click());
    await h.click('Transcribe recording');
    const transcript = document.querySelector('[aria-label="Transcription text"]')!;
    const cards = transcript.querySelectorAll('article');
    expect(cards).toHaveLength(2);
    const footer = document.querySelector('[aria-label="Transcription information"]')!;
    expect(footer.parentElement!.lastElementChild).toBe(footer);
    expect(footer.textContent).toContain('Transcription complete.');
    const audio = document.querySelector<HTMLAudioElement>('audio')!;
    const active = () => transcript.querySelectorAll('[aria-current="true"]');
    expect(active()).toHaveLength(0);
    const update = async (time: number) => {
      await act(async () => { audio.currentTime = time; audio.dispatchEvent(new window.Event('timeupdate')); });
    };
    await update(3); expect(active()).toHaveLength(1); expect(active()[0]).toBe(cards[0]);
    await update(5); expect(active()).toHaveLength(0);
    await update(8); expect(active()).toHaveLength(1); expect(active()[0]).toBe(cards[1]);
    await h.click('Seek to 0:02'); expect(audio.currentTime).toBe(2); expect(active()[0]).toBe(cards[0]);
    await act(async () => h.panel().querySelectorAll<HTMLButtonElement>('ul button')[1]!.click());
    expect(document.querySelector('[aria-label="Transcription text"] article')).toBeNull();
  }, { list: async () => twoRecordings, detail: detailFixture({
    transcription: async () => ({ status: 'complete', segments: [
      { start: 2, end: 4, text: 'First segment.' }, { start: 7, end: 10, text: 'Second segment.' },
    ] }),
  }) });
});

test('custom player controls playback, seeking, volume, speed and saving through the shared menus', async () => {
  const downloads: string[] = [];
  await withVoice(async h => {
    await h.click('Recordings');
    await act(async () => h.panel().querySelector<HTMLButtonElement>('ul button')!.click());
    const audio = document.querySelector<HTMLAudioElement>('audio')!;
    let paused = true;
    Object.defineProperties(audio, { duration: { configurable: true, value: 30 }, paused: { configurable: true, get: () => paused } });
    audio.play = async () => { paused = false; audio.dispatchEvent(new window.Event('play')); };
    audio.pause = () => { paused = true; audio.dispatchEvent(new window.Event('pause')); };
    await act(async () => audio.dispatchEvent(new window.Event('loadedmetadata')));
    await h.click('Play recording'); expect(paused).toBe(false);
    await h.click('Pause recording'); expect(paused).toBe(true);
    await h.click('Mute recording'); expect(audio.muted).toBe(true);
    await h.click('Unmute recording'); expect(audio.muted).toBe(false);
    const changeRange = async (label: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
      await act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    };
    await changeRange('Seek recording', '12'); expect(audio.currentTime).toBe(12);
    await changeRange('Recording volume', '0.4'); expect(audio.volume).toBe(0.4);
    const menuClick = async (label: string) => {
      const item = document.querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${label}"]`)!;
      expect(item).not.toBeNull(); await act(async () => item.click());
    };
    await h.click('Recording options'); await menuClick('Playback speed');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('1× (Normal)');
    await menuClick('Back'); expect(document.querySelector('[role="menu"]')?.textContent).toContain('Download');
    await menuClick('Playback speed'); await menuClick('1.5×'); expect(audio.playbackRate).toBe(1.5);
    expect(document.activeElement).toBe(h.button('Recording options'));
    await h.click('Recording options'); await menuClick('Download');
    expect(downloads).toEqual(['cheshi-voice://recording/1']);
    expect(document.querySelector('[aria-label="Audio player"]')?.textContent).toContain('Recording saved.');
    await act(async () => h.panel().querySelectorAll<HTMLButtonElement>('ul button')[1]!.click());
    expect(document.querySelector('[aria-label="Playback speed"]')?.textContent).toBe('1×');
    expect(document.querySelector('[aria-label="Audio player"]')?.textContent).not.toContain('Recording saved.');
  }, { list: async () => twoRecordings, detail: detailFixture({
    saveAudio: async url => { downloads.push(url); return 'saved'; },
  }) });
});
