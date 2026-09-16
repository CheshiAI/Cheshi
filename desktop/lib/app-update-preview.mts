import { setTimeout as delay } from 'node:timers/promises';
import type { AppRelease, AppUpdateProgress } from '../shared/app-update.ts';

/** Opt-in visual preview. This adapter has no network, filesystem, or installer dependencies. */
export function createAppUpdatePreview(options: {
  packaged: boolean;
  setting: string | undefined;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  if (options.packaged !== false || options.setting !== '1') return null;
  const wait = options.wait ?? delay;
  const release: AppRelease = {
    version: '0.0.2-alpha', tag: 'v0.0.2-alpha', url: '', asset: null,
    notes: [
      'Cheshi v0.0.2-alpha — Sample release notes',
      '',
      '• Check for updates at startup and every hour.',
      '• View release notes from the workspace status bar.',
      '• Restore editor tabs, unsaved drafts, and conversations after updating.',
      '• Improve update download verification and error recovery.',
      '',
      'This is a local UI preview. No GitHub release has been published.',
    ].join('\n'),
  };
  return {
    preview: true as const,
    unavailableReason: null,
    check: async () => structuredClone(release),
    openExternal: async () => {},
    async install(_release: AppRelease, report: (progress: AppUpdateProgress) => void) {
      for (const receivedBytes of [0, 25, 50, 75, 100]) {
        report({ phase: 'downloading', receivedBytes, totalBytes: 100 });
        await wait(240);
      }
      report({ phase: 'verifying' });
      await wait(600);
      report({ phase: 'installing' });
      await wait(1_200);
      throw new Error('Simulated update failure. Preview only; your app and files were not changed. You can retry.');
    },
  };
}
