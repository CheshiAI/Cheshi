import { describe, expect, it } from 'bun:test';
import { createAppUpdatePreview } from '../lib/app-update-preview.mts';
import { createAppUpdateService } from '../lib/app-update-service.mts';

describe('local update preview', () => {
  it('requires an explicit flag and never activates in a packaged app', () => {
    for (const setting of [undefined, '', '0', 'true', ' 1 ']) {
      expect(createAppUpdatePreview({ packaged: false, setting })).toBeNull();
    }
    expect(createAppUpdatePreview({ packaged: true, setting: '1' })).toBeNull();
    const malformedPackaged = { packaged: 'false', setting: '1' } as unknown as Parameters<typeof createAppUpdatePreview>[0];
    expect(createAppUpdatePreview(malformedPackaged)).toBeNull();
    expect(createAppUpdatePreview({ packaged: false, setting: '1' })).not.toBeNull();
  });

  it('replaces all update side effects while displaying sample notes and retryable progress', async () => {
    const waits: number[] = [];
    const preview = createAppUpdatePreview({ packaged: false, setting: '1', wait: async milliseconds => { waits.push(milliseconds); } });
    if (!preview) throw new Error('Expected preview adapter.');
    const effects: string[] = [];
    const productionOptions = {
      currentVersion: '0.0.1-alpha', unavailableReason: 'Unsigned development app',
      check: async () => { effects.push('network'); return null; },
      install: async () => { effects.push('install or restart'); },
      openExternal: async () => { effects.push('browser'); },
    };
    const service = createAppUpdateService({ ...productionOptions, ...preview });
    try {
      await service.resume();
      const state = service.snapshot();
      expect(state.preview).toBe(true);
      expect(state.currentVersion).toBe('0.0.1-alpha');
      expect(state.release?.tag).toBe('v0.0.2-alpha');
      expect(state.release?.notes).toContain('Sample release notes');
      expect(state.release?.asset).toBeNull();
      expect(state.release?.url).toBe('');
      expect(state.installUnavailableReason).toBeNull();
      await service.openRelease();
      const phases: string[] = [];
      service.subscribe(next => phases.push(next.phase));
      for (let attempt = 0; attempt < 2; attempt++) {
        let rejection: unknown;
        try { await service.install(); } catch (error) { rejection = error; }
        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as Error).message).toContain('Simulated update failure.');
        expect(service.snapshot().phase).toBe('idle');
      }
      expect(phases).toEqual(['downloading', 'installing', 'idle', 'downloading', 'installing', 'idle']);
      expect(waits).toEqual([1_200, 1_200, 1_200, 1_200]);
      expect(effects).toEqual([]);
    } finally { service.dispose(); }
  });

  it('does not allow truthy malformed preview flags to bypass real install requirements', async () => {
    const preview = createAppUpdatePreview({ packaged: false, setting: '1' });
    if (!preview) throw new Error('Expected preview adapter.');
    const service = createAppUpdateService({
      currentVersion: '0.0.1-alpha', check: preview.check, openExternal: async () => {},
      install: async () => { throw new Error('Must not reach installer'); }, unavailableReason: 'Not signed',
      ...({ preview: 'true' } as unknown as { preview: boolean }),
    });
    try {
      await service.resume();
      expect(service.snapshot().preview).toBeUndefined();
      expect(service.snapshot().installUnavailableReason).toBe('Not signed');
    } finally { service.dispose(); }
  });
});
