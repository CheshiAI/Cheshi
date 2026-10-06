import { parseToolCredentialRequest, parseToolTestRequest } from '../shared/homie-tools.ts';
import { AGENT_RUNTIME_CHANNEL, parseAgentRuntimeRequest, parseAgentRuntimeState } from '../shared/agent-runtime.ts';
import type { IpcRenderer } from 'electron';
import { AGENT_REGISTRY_CHANNELS, parseAgentRegistrySnapshot, parseAgentRegistrySaveResult, parseSaveSpecialistAgent, parseDeleteSpecialistAgent } from '../shared/agent-registry.ts';
import type { AgentRegistryApi } from '../shared/agent-registry.ts';
import { parseAgentModels } from '../shared/agent-models.ts';
import { isCodexAccountId } from '../shared/codex-accounts.ts';
import { parseInstructionFiles, parseInstructionFilePath } from '../shared/agent-registry.ts';
import { unwrapAgentDeletion } from '../shared/agent-management.ts';
import { parseAgentPackage, parseAgentPackages } from '../shared/agent-package.ts';

export function createAgentRegistryApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): AgentRegistryApi {
  return {
    async toolCredential(input) { return await ipc.invoke(AGENT_REGISTRY_CHANNELS.toolCredential, parseToolCredentialRequest(input)) === true; },
    async testTool(input) { return ipc.invoke(AGENT_REGISTRY_CHANNELS.testTool, parseToolTestRequest(input)); },
    async installPackage(value, instructionFiles = []) { return parseAgentPackage(await ipc.invoke(AGENT_REGISTRY_CHANNELS.installPackage, { definition: parseAgentPackage(value), instructionFiles: parseInstructionFiles(instructionFiles) })); },
    async exportPackage(value, instructionFiles = []) { return (await ipc.invoke(AGENT_REGISTRY_CHANNELS.exportPackage, { definition: parseAgentPackage(value), instructionFiles: parseInstructionFiles(instructionFiles) })) === true; },
    async packages() { return parseAgentPackages(await ipc.invoke(AGENT_REGISTRY_CHANNELS.packages)); },
    async importPackage() {
      const value = await ipc.invoke(AGENT_REGISTRY_CHANNELS.importPackage);
      return value === null ? null : parseAgentPackage(value);
    },
    async selectInstructionFiles() { return parseInstructionFiles(await ipc.invoke(AGENT_REGISTRY_CHANNELS.selectInstructionFiles)); },
    async openInstructionFile(path) { await ipc.invoke(AGENT_REGISTRY_CHANNELS.openInstructionFile, parseInstructionFilePath(path)); },
    async remove(input) { return parseAgentRegistrySnapshot(unwrapAgentDeletion(await ipc.invoke(AGENT_REGISTRY_CHANNELS.remove, parseDeleteSpecialistAgent(input)))); },
    async runtime(input) { return parseAgentRuntimeState(await ipc.invoke(AGENT_RUNTIME_CHANNEL, parseAgentRuntimeRequest(input))); },
    async models(accountId) {
      if (!isCodexAccountId(accountId)) throw new TypeError('Invalid agent account.');
      return parseAgentModels(await ipc.invoke(AGENT_REGISTRY_CHANNELS.models, accountId));
    },
    async list() { return parseAgentRegistrySnapshot(await ipc.invoke(AGENT_REGISTRY_CHANNELS.list)); },
    async save(input) { return parseAgentRegistrySaveResult(await ipc.invoke(AGENT_REGISTRY_CHANNELS.save, parseSaveSpecialistAgent(input))); },
    onDidChange(listener) {
      const receive = (_event: unknown, value: unknown) => listener(parseAgentRegistrySnapshot(value));
      ipc.on(AGENT_REGISTRY_CHANNELS.changed, receive);
      return () => { ipc.removeListener(AGENT_REGISTRY_CHANNELS.changed, receive); };
    },
  };
}
