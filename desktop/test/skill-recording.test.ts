import { expect, test } from 'bun:test';

import { startSkillCapture, type SkillCapture } from '../frontend/src/features/plugins/skillRecording.ts';
import { expectFailure } from './codex-chat-test-helpers.ts';

interface CaptureEnvironment {
  supported?: boolean;
  drawFails?: boolean;
  run: (state: { endSharing: () => void; stopped: () => boolean }) => Promise<void>;
}

async function withCaptureEnvironment({ run, supported = true, drawFails = false }: CaptureEnvironment) {
  let stopped = false;
  const track = { onended: null as (() => void) | null, stop: () => { stopped = true; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { muted: false, srcObject: null, videoWidth: 800, videoHeight: 600, readyState: 4, play: async () => {}, pause: () => {} };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => { if (drawFails) throw new Error('Capture failed.'); } }),
    toDataURL: () => 'data:image/jpeg;base64,/9j/2Q==',
  };
  class FakeRecorder {
    static isTypeSupported() { return supported; }
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]) });
        this.onstop?.();
      });
    }
  }
  const replacements: Record<string, unknown> = {
    navigator: { mediaDevices: { getDisplayMedia: async () => stream } },
    document: { createElement: (tag: string) => tag === 'video' ? video : canvas },
    MediaRecorder: FakeRecorder,
  };
  const original = new Map(Object.keys(replacements).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { configurable: true, value });
  try { await run({ endSharing: () => track.onended?.(), stopped: () => stopped }); }
  finally {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

for (const stopFrom of ['button', 'system picker']) {
  test(`stopping from the ${stopFrom} finalizes the recording and releases screen access`, async () => {
    await withCaptureEnvironment({ run: async ({ endSharing, stopped }) => {
      const capture = await startSkillCapture();
      try {
        if (stopFrom === 'button') capture.stop();
        else endSharing();
        const result = await capture.result;
        expect(stopped()).toBe(true);
        expect(result.video).toEqual(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
        expect(result.frames.length).toBeGreaterThan(0);
        expect(result.frames.every((frame) => frame.seconds <= result.durationSeconds)).toBe(true);
      } finally { capture.cancel(); }
    } });
  });
}

test('closing a recording cancels the result and releases screen access', async () => {
  await withCaptureEnvironment({ run: async ({ stopped }) => {
    const capture = await startSkillCapture();
    capture.cancel();
    await expectFailure(() => capture.result, 'Recording cancelled.');
    expect(stopped()).toBe(true);
  } });
});

test('unsupported video encoding releases the selected screen', async () => {
  await withCaptureEnvironment({ supported: false, run: async ({ stopped }) => {
    await expectFailure(startSkillCapture, 'WebM recording is unavailable on this device.');
    expect(stopped()).toBe(true);
  } });
});

test('a failed preview capture stops recording and rejects without leaking screen access', async () => {
  await withCaptureEnvironment({ drawFails: true, run: async ({ stopped }) => {
    let capture: SkillCapture | undefined;
    try {
      capture = await startSkillCapture();
      const result = capture.result;
      await expectFailure(() => result, 'The recording preview could not be captured.');
      expect(stopped()).toBe(true);
    } finally { capture?.cancel(); }
  } });
});
