import './style.css';
import { voiceId, voiceRecord, voiceSocketUrl, voiceText, voiceEndReason, VOICE_END_MESSAGES, type VoiceEndReason } from '../../shared/voice-protocol.ts';
import { PhoneCall } from './call.ts';
import { PhoneConnection } from './connection.ts';

const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state = (text: string) => { node('state').textContent = text; };
const button = (id: string) => node<HTMLButtonElement>(id);
const call = new PhoneCall(node<HTMLAudioElement>('audio'), state, reason => hangup(reason));
const params = new URLSearchParams(location.hash.slice(1));
let host = params.get('host'), pairing = params.get('pair');
history.replaceState(null, '', location.pathname);
interface Identity { host: string; id: string; token: string }
let identity: Identity | null = null;
try {
  const saved = localStorage.getItem('cheshi-phone');
  if (saved) { const v = voiceRecord(JSON.parse(saved)); identity = { host: voiceId(v.host), id: voiceId(v.id), token: voiceText(v.token, 128) }; }
} catch { state('기기 정보를 읽을 수 없습니다. Mac에서 새 연결을 만들어 주세요.'); }
if (host && identity?.host !== host) identity = null;
host ??= identity?.host ?? null;
let muted = false, callId: string | null = null, submitted = false, offer: string | null = null;
let pendingHangup: { type: 'hangup'; callId: string; reason: VoiceEndReason } | null = null;
const captions = new Map<string, { text: string; final: boolean }>();
const receipts = new Set<string>();
const connection = new PhoneConnection({
  url: voiceSocketUrl(location.origin),
  authenticate: () => ({ type: 'authenticate', role: 'phone', hostId: host, deviceId: identity!.id, token: identity!.token, name: 'My phone', pairing }),
  frame: receive, changed: () => controls(),
  interrupted: () => state('Mac 연결을 복구하는 중입니다. 음성 연결은 유지합니다…'),
  ended: reason => { end(); state(VOICE_END_MESSAGES[reason]); },
});
const send = (payload: unknown) => connection.send(payload);
function controls() {
  button('connect').disabled = connection.active;
  button('call').disabled = !connection.approved || !!callId;
  button('mute').disabled = !callId; button('hangup').disabled = !callId;
  for (const b of node('questions').querySelectorAll('button')) b.disabled = !callId || !connection.approved;
}
function end() {
  call.close(); callId = null; submitted = false; offer = null; muted = false;
  button('mute').textContent = '음소거'; controls();
}
function hangup(reason: VoiceEndReason = 'hangup') {
  if (callId && submitted) {
    pendingHangup = { type: 'hangup', callId, reason };
    if (connection.approved) { try { send(pendingHangup); pendingHangup = null; } catch { /* Retry after authentication. */ } }
  }
  end(); state(VOICE_END_MESSAGES[reason]);
}
function submitOffer() {
  if (callId && offer && !submitted && connection.approved) { send({ type: 'call', callId, sdp: offer }); submitted = true; }
}
function connect() {
  if (!host) { state('Mac의 Chats에서 휴대폰 연결 링크를 열어 주세요.'); return; }
  try {
    host = voiceId(host);
    identity ??= { host, id: crypto.randomUUID(), token: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('') };
    // Save before sending, so reload cannot lose a device which the Mac has approved.
    localStorage.setItem('cheshi-phone', JSON.stringify(identity));
    state('Mac에 연결하는 중입니다…'); connection.start();
  } catch (error) { state(error instanceof Error ? error.message : '연결 정보를 저장할 수 없습니다.'); }
}
async function receive(frame: Record<string, unknown>) {
  if (frame.type === 'challenge') { node('code').textContent = `Mac에 표시된 코드와 비교해 주세요: ${voiceText(frame.code, 6)}`; return; }
  if (frame.type === 'approved') {
    pairing = null; node('code').textContent = '';
    if (pendingHangup) { send(pendingHangup); pendingHangup = null; }
    if (callId && submitted) { send({ type: 'resume', callId }); state('진행 중인 통화를 확인하는 중입니다…'); }
    else { connection.recovered(); submitOffer(); state(callId ? '음성 연결을 준비합니다…' : '연결됨. 통화를 시작할 수 있습니다.'); }
    controls(); return;
  }
  if (frame.type !== 'event') return;
  const p = voiceRecord(frame.payload);
  if (p.callId !== undefined && p.callId !== callId) return;
  if (p.type === 'resumed') { connection.recovered(); state('Mac에 다시 연결됐습니다.'); }
  if (p.type === 'sdp' && callId) {
    const id = callId;
    try { await call.answer(voiceText(p.sdp, 64000)); } catch (error) { if (callId === id) throw error; }
  }
  if (p.type === 'ended' && callId) { connection.recovered(); end(); state(VOICE_END_MESSAGES[voiceEndReason(p.reason)]); }
  if (p.type === 'error') state(voiceText(p.message));
  if (p.type === 'transcript' && typeof p.text === 'string' && p.text) {
    const role = String(p.role), previous = captions.get(role);
    const text = p.final === true ? p.text.slice(0, 16000) : ((previous?.final ? '' : previous?.text ?? '') + p.text).slice(-16000);
    captions.set(role, { text, final: p.final === true });
    node('transcript').textContent = `${role === 'user' ? '나' : 'Cheshi'}: ${text}`;
  }
  if (p.type === 'receipt') {
    const id = voiceId(p.id); if (receipts.has(id)) return; receipts.add(id);
    if (receipts.size > 100) receipts.delete(receipts.values().next().value!);
    const item = document.createElement('li'); item.textContent = `접수됨: ${voiceText(p.text)}`; node('receipts').append(item);
    while (node('receipts').children.length > 20) node('receipts').firstElementChild?.remove();
  }
  if (p.type === 'room') {
    node('room').textContent = voiceText(p.roomName, 100);
    node('questions').replaceChildren();
    if (Array.isArray(p.questions)) for (const value of p.questions) {
      const q = voiceRecord(value), b = document.createElement('button'); b.textContent = `이 질문에 답하기: ${voiceText(q.text, 4000)}`;
      b.disabled = !callId || !connection.approved; b.onclick = () => { send({ type: 'answer', callId, questionId: voiceId(q.id), answerTo: voiceId(q.answerTo) }); state('선택한 질문에 대한 답을 말씀해 주세요.'); }; node('questions').append(b);
    }
    node('messages').replaceChildren();
    if (Array.isArray(p.messages)) for (const value of p.messages) { const m = voiceRecord(value), item = document.createElement('p'); item.textContent = `${String(m.status ?? '')} ${voiceText(m.text, 2000)}`; node('messages').append(item); }
  }
}
button('connect').onclick = connect;
button('call').onclick = async () => {
  const id = crypto.randomUUID(); callId = id; captions.clear(); controls(); state('마이크와 음성 연결을 준비합니다…');
  try { const sdp = await call.offer(); if (callId !== id) return; offer = sdp; submitOffer(); }
  catch (error) { if (callId !== id) return; hangup('startup-failed'); state(error instanceof Error ? error.message : VOICE_END_MESSAGES['startup-failed']); }
};
button('hangup').onclick = () => hangup();
button('mute').onclick = () => { muted = !muted; call.mute(muted); button('mute').textContent = muted ? '음소거 해제' : '음소거'; };
button('forget').onclick = () => { hangup(); connection.stop(); pendingHangup = null; localStorage.removeItem('cheshi-phone'); identity = null; host = null; pairing = null; state('이 기기의 정보를 지웠습니다. Mac에서도 연결을 해제할 수 있습니다.'); };
window.addEventListener('pagehide', () => { hangup(); connection.stop(); });
controls();
