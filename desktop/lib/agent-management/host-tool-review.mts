import { dialog, ipcMain, type BrowserWindow } from 'electron';
import type { HostToolRequest } from '../../shared/host-tools.ts';
import type { HostToolRegistration } from './host-tool-registration.mts';
import { confirmHostToolReview } from './host-tool-review-content.mts';
import { showHostToolDetails } from './host-tool-details.mts';

export function reviewHostTool(service: HostToolRegistration, window: BrowserWindow, workspace: string, request: HostToolRequest) {
  return service.request(workspace, request, {
    async selectExecutable(runtime) {
      if (window.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(window, { title: `Select the local ${runtime} executable`, properties: ['openFile'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    confirm(review) {
      return confirmHostToolReview(review, {
        available: () => !window.isDestroyed() && !window.webContents.isDestroyed(),
        summary: options => dialog.showMessageBox(window, options),
        details: text => showHostToolDetails(window, ipcMain, review.agentId, review.tool, text),
      });
    },
  });
}
