import { product } from '../../config/product.mts';
import type { CodexChatService } from './codex-chat-service.mts';
import { workspaceChatInstructions } from './workspace-chat-instructions.mts';

type ServiceOptions = ConstructorParameters<typeof CodexChatService>[0];

/** Foreground panes and scheduled tasks use the same workspace/session access. */
export function workspaceChatServiceOptions(cwd: string, conversations: ServiceOptions['conversations'],
  createMcpProbeClient: ServiceOptions['createMcpProbeClient']) {
  return {
    conversations,
    createMcpProbeClient,
    cwd,
    serviceName: product.internalName,
    historyToolsEnabled: true,
    developerInstructions: workspaceChatInstructions(product.displayName),
    log: (event: string, details: Record<string, unknown>) => {
      process.stderr.write(`[cheshi] ${event} ${JSON.stringify(details)}\n`);
    },
  };
}
