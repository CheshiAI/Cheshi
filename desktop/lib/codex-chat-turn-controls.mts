import type { ActiveTurn, ChatCollaborationMode, ChatModel, ChatSkill, CodexChatClient, JsonObject } from './codex-chat-types.mts';
import { assertChatMessageSize, assertChatSkillAvailable, chatAttachments, messageWithFileReferences, requiredString } from './codex-chat-values.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

type TurnControlContext = {
  client: CodexChatClient; viewedThreadId: string | null; activeTurns: Map<string, ActiveTurn>;
  pendingNewTurnClientMessageId: string | null; pendingTurnStarts: Set<string | null>; availableSkills: Map<string, ChatSkill>;
  selectedCollaborationMode: ChatCollaborationMode;
  selectedReasoningEffort: string; selectedModel: string | null;
  currentModel(): ChatModel | null; listModels(): Promise<unknown>; configuration(): JsonObject;
  emit(event: JsonObject): void;
};
export function chatMessageFailure(error: unknown, submitted: boolean, accepted = false): Error {
  const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error });
  failure.name = !accepted && (!submitted || (error instanceof Error && error.name === 'CodexRequestRejectedError'))
    ? 'CodexMessageNotSent' : 'CodexMessageDeliveryUnknown';
  return failure;
}
export function setCodexCollaborationMode(context: TurnControlContext, value: unknown): JsonObject {
  if (value !== 'default' && value !== 'plan') throw new TypeError('The collaboration mode must be default or plan.');
  if (context.activeTurns.size || context.pendingTurnStarts.size || context.pendingNewTurnClientMessageId) throw new Error('Wait for the current response before changing conversation mode.');
  context.selectedCollaborationMode = value;
  const configuration = context.configuration();
  context.emit({ type: 'configuration-changed', configuration });
  return configuration;
}
export async function codexCollaborationOverride(context: TurnControlContext): Promise<JsonObject> {
  const mode = context.selectedCollaborationMode;
  if (!context.currentModel()) await context.listModels();
  const model = requiredString(context.currentModel()?.model, 'Collaboration model');
  return { collaborationMode: { mode, settings: { model, reasoning_effort: context.selectedReasoningEffort, developer_instructions: null } } };
}
function assertSteerTurn(context: TurnControlContext, threadId: string, active: ActiveTurn | undefined, pending: Set<string>): asserts active is ActiveTurn & { turnId: string } {
  if (threadId !== context.viewedThreadId || !active?.turnId || active.interruptRequested) throw new Error('The response is no longer available for additional instructions.');
  if (pending.has(threadId)) throw new Error('Additional instructions are already being sent.');
}
function assertSteerAcknowledgement(value: unknown, expectedTurnId: string): void {
  if (stringValue(recordValue(value)?.turnId) !== expectedTurnId) throw new Error('Codex returned an invalid additional instruction acknowledgement.');
}
export async function steerCodexMessage(context: TurnControlContext, pending: Set<string>, text: unknown, clientMessageId: unknown,
  selectedSkill: unknown = null, attachments: unknown = [], targetThreadId: unknown = undefined): Promise<{ threadId: string; turnId: string }> {
  let submitted = false;
  let lockedThreadId: string | null = null;
  try {
    const threadId = requiredString(targetThreadId === undefined ? context.viewedThreadId : targetThreadId, 'Chat session id');
    const active = context.activeTurns.get(threadId);
    assertSteerTurn(context, threadId, active, pending);
    const message = requiredString(text, 'Chat message');
    const messageId = requiredString(clientMessageId, 'Client message id');
    const reference = selectedSkill === null ? null : recordValue(selectedSkill);
    const skillName = reference === null ? null : requiredString(reference.name, 'Skill name');
    const skillPath = reference === null ? null : requiredString(reference.path, 'Skill path');
    const skill = skillPath === null ? null : context.availableSkills.get(skillPath);
    assertChatSkillAvailable(reference !== null, skill, skillName);
    const normalized = chatAttachments(attachments);
    const messageInput = messageWithFileReferences(message, normalized);
    assertChatMessageSize(messageInput);
    pending.add(threadId);
    lockedThreadId = threadId;
    const expectedTurnId = active.turnId;
    submitted = true;
    const response = await context.client.request('turn/steer', {
      threadId, expectedTurnId, clientUserMessageId: messageId,
      input: [...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []),
        { type: 'text', text: messageInput, text_elements: [] }, ...normalized.filter(item => item.kind === 'image').map(item => ({ type: 'localImage', path: item.path }))],
    });
    assertSteerAcknowledgement(response, expectedTurnId);
    // Completion may race the acknowledgement. Never restart, replace or clear that turn.
    return { threadId, turnId: expectedTurnId };
  } catch (error) {
    throw chatMessageFailure(error, submitted);
  } finally {
    if (lockedThreadId) pending.delete(lockedThreadId);
  }
}
