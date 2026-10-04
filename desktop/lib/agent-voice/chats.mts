import { randomUUID } from 'node:crypto';
import type { ChatsRequest, ChatsSnapshot } from '../../shared/agent-chats.ts';
import { VoiceStorage, type Device } from './storage.mts';

export type ChatAccess = (request: ChatsRequest) => ChatsSnapshot;
export class VoiceChats {
  private readonly storage: VoiceStorage;
  private readonly request: ChatAccess;
  constructor(storage: VoiceStorage, request: ChatAccess) { this.storage = storage; this.request = request; }
  room(id: string) {
    const room = this.request({ action: 'list' }).rooms.find(r => r.id === id);
    if (!room) throw new Error('The linked Chats room is no longer available.');
    return room;
  }
  view(device: Device) {
    this.room(device.roomId);
    const all = this.request({ action: 'list' }).messages.filter(m => m.roomId === device.roomId);
    const root = all.find(m => m.id === device.threadId);
    const messages = all.filter(m => m.id === device.threadId || m.threadId === device.threadId);
    return { roomName: this.room(device.roomId).name, threadId: device.threadId,
      status: root?.status ?? null,
      messages: messages.slice(-12).map(m => ({ id: m.id, text: m.text.slice(0, 2000), sender: m.sender, status: m.status ?? null })),
      questions: messages.flatMap(m => (m.dialogue?.questions ?? []).filter(q => !q.answer).map(q => ({ id: q.id, answerTo: m.id, text: q.text }))).slice(-16),
    };
  }
  deliver(device: Device, text: string, answer: { questionId: string; answerTo: string } | null) {
    this.room(device.roomId);
    if (this.storage.state.pending.some(p => p.deviceId === device.id)) throw new Error('A previous voice instruction needs reconciliation. Reconnect before sending again.');
    const view = this.view(device);
    if (view.questions.length && !answer) throw new Error('Select the question to answer on your phone before speaking.');
    if (answer && !view.questions.some(q => q.id === answer.questionId && q.answerTo === answer.answerTo)) throw new Error('This question is no longer awaiting an answer.');
    const threadId = !answer && view.status === 'completed' ? null : device.threadId;
    const request: Extract<ChatsRequest, { action: 'send' }> = { action: 'send', id: `voice_${randomUUID()}`, roomId: device.roomId,
      threadId, recipient: null, text, goal: false, automatic: true, ...(answer ?? {}) };
    this.storage.enqueue(device, request);
    this.request(request);
    this.storage.acknowledged(device, request.id, threadId ?? request.id);
    return request.id;
  }
  reconcile(device: Device) {
    this.room(device.roomId);
    for (const pending of [...this.storage.state.pending].filter(p => p.deviceId === device.id)) {
      if (pending.request.roomId !== device.roomId || pending.account !== device.account) throw new Error('Saved voice delivery belongs to a different room or account.');
      this.request(pending.request);
      this.storage.acknowledged(device, pending.request.id, pending.request.threadId ?? pending.request.id);
    }
  }
}
