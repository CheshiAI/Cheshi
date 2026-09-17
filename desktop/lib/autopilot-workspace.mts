import { EphemeralSessionService } from './ephemeral-session-service.mts';
import type { CodexChatClient } from './codex-chat-types.mts';
import type { CodexChatService } from './codex-chat-service.mts';
import { createAutopilotCodex } from './autopilot-codex.mts';

type Selection = Pick<CodexChatService, 'listModels' | 'selectedModel' | 'selectedReasoningEffort'>;

/** Keep the temporary-session lifecycle and Research account lease together. */
export function createWorkspaceResearch(options: {
  client: CodexChatClient;
  cwd: string;
  service(contextId?: string): Selection | null;
}) {
  let session = new EphemeralSessionService(options.client, options.cwd);
  const research = createAutopilotCodex({ session: () => session, configuration: async contextId => {
    const service = options.service(contextId);
    if (!service) throw new Error('Select a Codex chat model before starting Research.');
    // Snapshot the choice before awaiting model discovery.
    const selectedModel = service.selectedModel;
    const effort = service.selectedReasoningEffort;
    const { models } = await service.listModels();
    const model = selectedModel ?? models.find(model => model.isDefault)?.model;
    if (!model) throw new Error('No Codex model is available on the connected account.');
    return { model, effort };
  } });
  return {
    research,
    get session() { return session; },
    reset() {
      session.stop();
      session = new EphemeralSessionService(options.client, options.cwd);
    },
  };
}
