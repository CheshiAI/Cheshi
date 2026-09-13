import { setTimeout as delay } from 'node:timers/promises';
import type { AppRelease } from '../shared/app-update.ts';

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
    async install(_release: AppRelease, installing: () => void) {
      await wait(1_200);
      installing();
      await wait(1_200);
      throw new Error('Simulated update failure. Preview only; your app and files were not changed. You can retry.');
    },
  };
}
