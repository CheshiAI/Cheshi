# Cheshi phone connection

This opt-in connection service serves `connect/client` and relays approved phone
sessions to a running Mac. The Mac initiates its WebSocket connection; its
router needs no incoming port forwarding. This is a Cheshi web call, not an
integration with Apple's Phone or Messages apps.

## Layout

- `client/`: browser call screen, microphone and audio playback.
- `server/`: static client delivery and approved WebSocket relay.
- `shared/`: platform-independent transport validation used by the client,
  server and desktop host. It does not import desktop modules.
- `test/`: server unit tests and cross-component checks, including the opt-in
  live voice test.
- `../desktop/lib/agent-voice/`: Mac approvals, voice sessions and Chats delivery.
- `../desktop/shared/agent-voice.ts`: desktop IPC types and validation only.

The connection components share `tsconfig.base.json`, independently of desktop
compiler settings. Electron packaging includes the shared transport module;
the browser client, relay and test tools are built or run separately.

## Local development

Run from the repository root with Bun:

```sh
bun install --frozen-lockfile
bun run phone:build
CHESHI_CONNECT_ORIGIN=http://127.0.0.1:8788 bun run connect:start
```

Start the desktop in a separate terminal:

```sh
CHESHI_CONNECT_URL=http://127.0.0.1:8788 bun run desktop:dev
```

In Chats, open **Phone calls**, choose **Link a phone to this room**, and open
the temporary link. Compare the code on both devices before approving. The link
expires after two minutes; an approved device can reconnect without it.
Loopback HTTP is for testing on the same computer only. A phone outside the Mac's
network needs a public HTTPS endpoint, hosted or tunneled as described below.

## Deployment boundary

Deploy the service and built phone assets together behind an HTTPS reverse proxy
supporting WebSocket upgrades. Set `CHESHI_CONNECT_ORIGIN` to that exact public
origin, preserve its `Host` header, and set the Mac's `CHESHI_CONNECT_URL` to the
same origin. Bind the Bun process to loopback when the proxy is on the same host.
Use `CHESHI_CONNECT_BIND` and `PORT` only when the deployment needs
a different private listener. TLS certificates and a deployment host are operator
configuration; this change does not create or deploy public infrastructure.

For an authorized development test, a Quick Tunnel can expose the loopback
listener without deploying a server. Start `cloudflared tunnel --url
http://127.0.0.1:8788`, then set both `CHESHI_CONNECT_ORIGIN` for the relay and
`CHESHI_CONNECT_URL` for the desktop to the resulting HTTPS origin. Restart both
processes when changing that origin. Quick Tunnel addresses are temporary;
browser device credentials belong to the original origin and do not transfer
to a new address.

The first version runs one relay process. Connected Macs and phones must reach
that same process. Both ends retry temporary control disconnections automatically.
The Mac retains the existing provider session for up to 30 seconds; the phone
must authenticate again and resume the same call ID under the same device,
account and room. A relay restart can recover within that window. A Mac app
restart loses the live voice session, so the phone must start a new call.
There is no server-side offline instruction queue. A Mac that is shut down, asleep or disconnected cannot receive a call.

## Access and data

- Mac identity is a random local secret; the public routing ID is its SHA-256
  digest. Each phone has a separate revocable capability.
- Approval grants one project and Chats room under the active account profile.
  Switching accounts removes approvals; restoring that profile during startup
  preserves them. Existing Chats membership and agent permission checks still
  run for each instruction.
- Pairing secrets travel in URL fragments, not HTTP paths or query strings.
  The phone clears the fragment after reading it. Do not log WebSocket frames,
  authorization tokens or pairing URLs at the proxy or application layer.
- The relay forwards signaling, device authentication and displayed text over
  TLS. It does **not** provide end-to-end encryption against the relay operator.
  It keeps connection state in memory and does not persist conversations or audio.
- Media uses the negotiated WebRTC connection to the voice provider. Codex
  credentials stay on the Mac. No API key is sent to the phone or relay; this
  adapter requires an existing ChatGPT login and the experimental v3 realtime
  protocol in the installed Codex runtime. Account availability is checked when
  a call starts, not promised for every subscription or runtime version.
- `voice.json` in the workspace's user-data voice directory is written with mode
  `0600`. It contains the Mac secret, device token hashes, bindings, and any
  unacknowledged instruction. Final instructions use Chats' durable request IDs.
  Ambiguous delivery is reconciled with the same ID, never a new execution ID.
- The phone stores its revocable capability in this origin's local storage.
  **Unlink** on the Mac revokes it. Clearing phone storage alone does not remove
  the Mac's approval record.
- Final speech is sent automatically; partial transcripts never execute work.
  A pending user question must be selected before its spoken answer is accepted.
  Hanging up ends the isolated voice process, not accepted Chats work.
- The voice session has no project tools. It relays instructions and reads room
  replies; actual work uses the existing Homies orchestration and approval rules.

## Temporary disconnections

A control outage does not immediately close WebRTC audio. While control is being
restored, final speech can still reach the Mac directly from the voice provider
and be delivered to Chats. Receipts are replayed after recovery without creating
new requests. These grace periods limit recovery attempts, not call duration:

- Control reconnect and authenticated call recovery: 30 seconds after loss is
  detected. Existing heartbeats detect a silent connection at their next check
  after 75 seconds without a pong.
- WebRTC `disconnected`: 15 seconds to return to `connected`. `failed` and a lost
  microphone end media immediately; this does not initiate an ICE restart.
- Hangup closes local media immediately. If control is offline, the phone sends
  its scoped hangup after reauthentication; otherwise the Mac's grace expires.
- Unlink, account changes and authentication rejection stop recovery. A changed
  tunnel URL or a reloaded/closed phone page requires a new call.

`voice-diagnostics.json`, beside `voice.json`, keeps the latest 100 local connection
and call events with timestamps, close codes and fixed reason codes. It excludes
speech, SDP, credentials and URLs. Phone console diagnostics contain only close
codes and media state. Restart the Mac app and relay together after updating the
protocol, rebuild phone assets, and reload the phone page before testing.

## Validation

```sh
bun run connect:test
bun run connect:typecheck
bun run phone:typecheck
bun run phone:build
```

An explicitly authorized live test is available on macOS with Chrome and Codex:

```sh
CHESHI_TEST_REAL_VOICE=1 bun connect/test/live-voice.mts
```

It uses a fresh browser, synthetic Korean audio, a temporary Mac identity, and a
Chats fixture. It never captures the microphone or dispatches real agent work.
It checks approval, real media, transcription, one-time instruction delivery,
reply readback, reconnection, revocation, and hangup cleanup. It uses the existing
login and may consume provider usage. Passing it does not establish external
iPhone/Safari connectivity, behavior behind every NAT, or packaged-app UI quality.
Those require the deployed HTTPS endpoint and real devices.

The synthetic input keeps a quiet audio source running after its spoken clip,
matching an active microphone. Stopping that source can stall the voice session's
timeline. See the official [session and audio guidance](https://developers.openai.com/api/docs/guides/live-conversations)
and [Codex App Server protocol documentation](https://learn.chatgpt.com/docs/app-server).
