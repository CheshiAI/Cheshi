import './style.css';
import { parseVoiceFrame, voiceId, voiceRecord, voiceSocketUrl, voiceText } from '../../shared/voice-protocol.ts';
import { PhoneCall } from './call.ts';

const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state = (text: string) => { node('state').textContent = text; };
const button = (id: string) => node<HTMLButtonElement>(id);
const call = new PhoneCall(node<HTMLAudioElement>('audio'), state, () => { try { send({ type: 'hangup' }); } finally { end(); } });
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
let socket: WebSocket | null = null, approved = false, muted = false, calling = false;
let heartbeat: ReturnType<typeof setInterval> | null = null, pong = 0;
const captions = new Map<string, { text: string; final: boolean }>();
const send = (payload: unknown) => { if (socket?.readyState !== WebSocket.OPEN || !approved) throw new Error('먼저 Mac에 연결해 주세요.'); socket.send(JSON.stringify({ type: 'request', payload })); };
const controls = () => { button('connect').disabled = !!socket; button('call').disabled = !approved || calling; button('mute').disabled = !calling; button('hangup').disabled = !calling; };
const end = () => { call.close(); calling = false; muted = false; button('mute').textContent = '음소거'; controls(); };
function connect() {
  if (!host) { state('Mac의 Chats에서 휴대폰 연결 링크를 열어 주세요.'); return; }
  try {
    host = voiceId(host);
    identity ??= { host, id: crypto.randomUUID(), token: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('') };
    // Save before sending, so reload cannot lose a device which the Mac has approved.
    localStorage.setItem('cheshi-phone', JSON.stringify(identity));
    const ws = new WebSocket(voiceSocketUrl(location.origin)); socket = ws; controls();
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'authenticate', role: 'phone', hostId: host, deviceId: identity!.id, token: identity!.token, name: 'My phone', pairing })); state('Mac의 승인을 기다립니다.'); };
    ws.onmessage = event => { if (socket === ws) void receive(String(event.data)).catch(() => { state('연결 메시지를 처리할 수 없습니다.'); ws.close(); }); };
    ws.onerror = () => state('연결할 수 없습니다. Mac과 연결 서버의 상태를 확인해 주세요.');
    ws.onclose = () => { if (socket !== ws) return; socket = null; approved = false; if (heartbeat) clearInterval(heartbeat); heartbeat = null; end(); state('연결이 종료됐습니다. 이미 접수한 작업은 Chats에서 계속됩니다.'); };
  } catch (error) { state(error instanceof Error ? error.message : '연결 정보를 저장할 수 없습니다.'); }
}
async function receive(text: string) {
  const frame = parseVoiceFrame(text);
  if (frame.type === 'challenge') { node('code').textContent = `Mac에 표시된 코드와 비교해 주세요: ${voiceText(frame.code, 6)}`; return; }
  if (frame.type === 'pong') { pong = Date.now(); return; }
  if (frame.type === 'approved') {
    pairing = null; approved = true; pong = Date.now(); node('code').textContent = ''; state('연결됨. 통화를 시작할 수 있습니다.'); controls();
    heartbeat = setInterval(() => { if (Date.now() - pong > 75000) socket?.close(); else socket?.send(JSON.stringify({ type: 'ping' })); }, 15000); return;
  }
  if (frame.type !== 'event') return;
  const p = voiceRecord(frame.payload);
  if (p.type === 'sdp') await call.answer(voiceText(p.sdp, 64000));
  if (p.type === 'ended') { end(); state('통화가 종료됐습니다.'); }
  if (p.type === 'error') state(voiceText(p.message));
  if (p.type === 'transcript' && typeof p.text === 'string' && p.text) {
    const role = String(p.role), previous = captions.get(role);
    const text = p.final === true ? p.text.slice(0, 16000) : ((previous?.final ? '' : previous?.text ?? '') + p.text).slice(-16000);
    captions.set(role, { text, final: p.final === true });
    node('transcript').textContent = `${role === 'user' ? '나' : 'Cheshi'}: ${text}`;
  }
  if (p.type === 'receipt') {
    const item = document.createElement('li'); item.textContent = `접수됨: ${voiceText(p.text)}`; node('receipts').append(item);
    while (node('receipts').children.length > 20) node('receipts').firstElementChild?.remove();
  }
  if (p.type === 'room') {
    node('room').textContent = voiceText(p.roomName, 100);
    node('questions').replaceChildren();
    if (Array.isArray(p.questions)) for (const value of p.questions) {
      const q = voiceRecord(value), b = document.createElement('button'); b.textContent = `이 질문에 답하기: ${voiceText(q.text, 4000)}`;
      b.disabled = !calling; b.onclick = () => { send({ type: 'answer', questionId: voiceId(q.id), answerTo: voiceId(q.answerTo) }); state('선택한 질문에 대한 답을 말씀해 주세요.'); }; node('questions').append(b);
    }
    node('messages').replaceChildren();
    if (Array.isArray(p.messages)) for (const value of p.messages) { const m = voiceRecord(value), item = document.createElement('p'); item.textContent = `${String(m.status ?? '')} ${voiceText(m.text, 2000)}`; node('messages').append(item); }
  }
}
button('connect').onclick = connect;
button('call').onclick = async () => {
  calling = true; captions.clear(); controls(); state('마이크와 음성 연결을 준비합니다…');
  try { const sdp = await call.offer(); send({ type: 'call', sdp }); }
  catch (error) { end(); state(error instanceof Error ? error.message : '통화를 시작할 수 없습니다.'); }
};
button('hangup').onclick = () => { try { send({ type: 'hangup' }); } finally { end(); } };
button('mute').onclick = () => { muted = !muted; call.mute(muted); button('mute').textContent = muted ? '음소거 해제' : '음소거'; };
button('forget').onclick = () => { socket?.close(); end(); localStorage.removeItem('cheshi-phone'); identity = null; host = null; pairing = null; state('이 기기의 정보를 지웠습니다. Mac에서도 연결을 해제할 수 있습니다.'); };
window.addEventListener('pagehide', () => { try { if (calling) send({ type: 'hangup' }); } finally { end(); socket?.close(); } });
controls();
