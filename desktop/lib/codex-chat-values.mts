import type { ChatAttachment, ChatSkill } from "./codex-chat-types.mts";
import { recordValue, stringValue } from "./codex-service-utils.mts";

export const MAX_MESSAGE_BYTES = 512 * 1024;

export function assertChatTurnAvailable(active: boolean, pendingNewMessageId: string | null): void {
  if (active) throw new Error("A response is already in progress for this chat.");
  if (pendingNewMessageId) throw new Error("A new chat response is already starting.");
}

export function assertChatSkillAvailable(required: boolean, skill: ChatSkill | null | undefined, name: string | null): void {
  if (required && (!skill || skill.name !== name)) {
    throw new Error("The selected Codex skill is no longer available. Open /skills and choose it again.");
  }
}

export function assertChatMessageSize(message: string): void {
  if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
    throw new Error("Chat messages must be 512 KB or smaller.");
  }
}

const MAX_CHAT_ATTACHMENTS = 20;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${label} must be a non-empty string.`);
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        const text = stringValue(item)?.trim();
        return text ? [text] : [];
      }),
    ),
  ];
}

/**
 * @param {string | null} threadId
 * @returns {asserts threadId is string}
 */
export function assertThreadId(threadId: string | null): asserts threadId is string {
  if (!threadId) throw new Error("Codex did not return a thread id.");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  const record = recordValue(value);
  return stringValue(record?.message) ?? String(value);
}

/**
 * @param {unknown} value
 * @returns {ChatAttachment[]}
 */
export function chatAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new TypeError("Chat attachments must be an array.");
  if (value.length > MAX_CHAT_ATTACHMENTS) {
    throw new TypeError(
      `Chat messages support up to ${MAX_CHAT_ATTACHMENTS} attachments.`,
    );
  }
  return value.map((attachmentValue) => {
    const attachment = recordValue(attachmentValue);
    if (!attachment)
      throw new TypeError("Each chat attachment must be an object.");
    const kind = stringValue(attachment.kind);
    if (kind !== "image" && kind !== "file")
      throw new TypeError("Chat attachment kind is invalid.");
    return {
      kind,
      name: requiredString(attachment.name, "Chat attachment name"),
      path: requiredString(attachment.path, "Chat attachment path"),
    };
  });
}

/**
 * @param {string} message
 * @param {ChatAttachment[]} attachments
 * @returns {string}
 */
export function messageWithFileReferences(
  message: string,
  attachments: ChatAttachment[],
): string {
  const files = attachments.filter(({ kind }) => kind === "file");
  if (files.length === 0) return message;
  return `${message}\n\nAttached files:\n${files.map(({ path }) => `- ${JSON.stringify(path)}`).join("\n")}`;
}
