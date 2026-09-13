import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { LanguageServerManager } from './language-server-manager.mts';

interface LanguageServerIpcContext {
  ipcMain: Pick<IpcMain, 'handle'>;
  languageServerManager: LanguageServerManager;
  assertCheshiSender(event: IpcMainInvokeEvent): void;
  selectLanguageServerExecutable(event: IpcMainInvokeEvent, language: unknown): Promise<unknown>;
}

export function registerLanguageServerIpcHandlers({
  ipcMain,
  languageServerManager,
  assertCheshiSender,
  selectLanguageServerExecutable,
}: LanguageServerIpcContext) {
  ipcMain.handle('cheshi:get-language-servers', (event) => {
    assertCheshiSender(event);
    return languageServerManager.getStatuses();
  });
  ipcMain.handle('cheshi:configure-language-server', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.configure(request);
  });
  ipcMain.handle('cheshi:select-language-server-executable', (event, language) => (
    selectLanguageServerExecutable(event, language)
  ));
  ipcMain.handle('cheshi:update-language-server-document', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.updateDocument(request);
  });
  ipcMain.handle('cheshi:get-language-server-completions', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.getCompletions(request);
  });
  ipcMain.handle('cheshi:get-language-server-hover', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.getHover(request);
  });
  ipcMain.handle('cheshi:get-language-server-definitions', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.getDefinitions(request);
  });
  ipcMain.handle('cheshi:get-language-server-references', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.getReferences(request);
  });
  ipcMain.handle('cheshi:get-language-server-signature-help', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.getSignatureHelp(request);
  });
  ipcMain.handle('cheshi:prepare-language-server-rename', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.prepareRename(request);
  });
  ipcMain.handle('cheshi:rename-language-server-symbol', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.renameSymbol(request);
  });
  ipcMain.handle('cheshi:get-language-server-code-actions', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.getCodeActions(request);
  });
  ipcMain.handle('cheshi:close-language-server-document', (event, request) => {
    assertCheshiSender(event);
    return languageServerManager.closeDocument(request);
  });
}
