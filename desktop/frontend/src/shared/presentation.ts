import { cheshiDesktop } from '../cheshiDesktop';

export const PRESENTATION_ACCOUNT_LABEL = 'Codex account';

/** True when the app was started with CHESHI_PRESENTATION=1 to hide personal identity while recording. */
export const presentationMode = cheshiDesktop?.presentationMode === true;

export function presentationUserName(userName: string, hidden = presentationMode): string {
  return hidden ? '' : userName;
}

export function presentationWorkspaceRoot(workspaceRoot: string, workspaceName: string, hidden = presentationMode): string {
  return hidden ? `…/${workspaceName}` : workspaceRoot;
}

export function presentationAccountName(name: string, hidden = presentationMode): string {
  return hidden ? PRESENTATION_ACCOUNT_LABEL : name;
}
