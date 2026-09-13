import { chatRelayConsensusDisplay, parseChatRelayConsensusReply, type parseChatRelayMessage } from '../../../../shared/chat-relay';

type RelayMessage = NonNullable<ReturnType<typeof parseChatRelayMessage>>;

/** Present the conversation content, while retaining the full prompt in history. */
export function relayDisplayText({ provenance, body }: RelayMessage): string {
  if (provenance.displayText !== undefined) return provenance.displayText;
  if (!body.startsWith('This is a bounded three-step conversation relay:')) return body;

  if (provenance.role === 'proposal') {
    const objectiveMarker = '\n\nObjective: ';
    const instruction = '\n\nPropose an approach to the objective.';
    const start = body.indexOf(objectiveMarker);
    if (start >= 0 && body.endsWith(instruction)) {
      return body.slice(start + objectiveMarker.length, -instruction.length);
    }
  } else {
    const instruction = provenance.role === 'review'
      ? 'Review the proposal for correctness, omissions, and tradeoffs. Give concrete feedback.'
      : 'Revise your earlier proposal using the review. Provide the final recommendation.';
    const opening = `\n\n${instruction}\n\nCompleted output from conversation ${provenance.sourceThreadId}:\n<quoted_conversation_output>\n`;
    const closing = '\n</quoted_conversation_output>';
    const start = body.indexOf(opening);
    if (start >= 0 && body.endsWith(closing)) {
      return body.slice(start + opening.length, -closing.length);
    }
  }

  return body;
}

/** Keep marked relay protocol output out of both live and reopened transcripts. */
export function relayAssistantDisplayText(text: string, streaming: boolean): string {
  const reply = parseChatRelayConsensusReply(text);
  if (reply) return chatRelayConsensusDisplay(reply);
  if (/^\s*```cheshi-relay(?:\s|$)/.test(text)) {
    return streaming ? 'Preparing consensus response…' : 'Consensus response could not be interpreted.';
  }
  return text;
}
