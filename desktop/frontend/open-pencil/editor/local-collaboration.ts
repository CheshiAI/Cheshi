// Keep the transport boundary local even if an upstream room entry point is added.
// No MQTT, WebRTC, STUN or TURN client is loaded by this adapter.
export function joinCollabRoom(_roomId: string): never {
  throw new Error('Real-time collaboration is disabled in Cheshi Canvas.');
}

export type {
  CollabActionReceiver,
  CollabRoomTransport,
  JoinCollabRoom,
} from '../../../../vendor/open-pencil/src/app/collab/transport/types';
