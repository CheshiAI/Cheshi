import { basename } from 'node:path';
import type { MessageBoxOptions } from 'electron';
import type { HostToolReview } from './host-tool-registration.mts';

const concise = (value: string, limit = 80) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

export function hostToolReviewSummary(review: HostToolReview): MessageBoxOptions {
  return {
    type: 'warning', title: 'Allow host tool',
    message: `Allow ${concise(review.name)} to run ${concise(review.tool)}?`,
    detail: [
      'Runs on this computer with your user permissions, outside Docker. It can access files, devices and network services; access is not limited to this project folder.',
      `Project: ${concise(basename(review.workspace))}\nRuntime: ${concise(review.runtime)} · ${concise(basename(review.executable))}`,
      'Review full paths, fingerprints and included files in View details. macOS privacy permissions are separate.',
    ].join('\n\n'),
    buttons: ['Cancel', 'Allow this tool', 'View details'], defaultId: 0, cancelId: 0, noLink: true,
  };
}

export function hostToolReviewDetails(review: HostToolReview) {
  return [
    `Homie: ${review.name}\nTool: ${review.tool}\nRuntime: ${review.runtime}`,
    `Project: ${review.workspace}\nHomie ID: ${review.agentId}\nAccount ID: ${review.accountId}`,
    `Executable: ${review.executable}\nExecutable SHA-256: ${review.executableHash}`,
    `Entry point: ${review.script}\nBundle SHA-256: ${review.digest}`,
    'Working folder: a temporary copy of the reviewed bundle',
    `Output: ${review.output} (temporary per call)`,
    `Included bundle files (${review.files.length}):\n${review.files.join('\n')}`,
  ].join('\n\n');
}

/** Viewing details cannot grant access; only the native Allow button can. */
export async function confirmHostToolReview(review: HostToolReview, ui: {
  available(): boolean;
  summary(options: MessageBoxOptions): Promise<{ response: number }>;
  details(text: string): Promise<boolean>;
}) {
  while (ui.available()) {
    const result = await ui.summary(hostToolReviewSummary(review));
    if (!ui.available()) return false;
    if (result.response === 1) return true;
    if (result.response !== 2 || await ui.details(hostToolReviewDetails(review)) !== true) return false;
  }
  return false;
}
