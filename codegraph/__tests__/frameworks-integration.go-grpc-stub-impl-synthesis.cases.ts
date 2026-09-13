import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerGoGrpcStubImplSynthesisTests(): void {


  describe('Go gRPC stub→impl synthesis', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('bridges UnimplementedMsgServer methods to the hand-written keeper impl', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-grpc-'));
      // Mimic protoc-gen-go-grpc output: `*_grpc.pb.go` carrying the
      // UnimplementedMsgServer stub.
      fs.writeFileSync(
        path.join(tmpDir, 'tx_grpc.pb.go'),
        'package banktypes\n\n' +
        'type UnimplementedMsgServer struct{}\n\n' +
        'func (UnimplementedMsgServer) Send(ctx context.Context, req *MsgSend) (*MsgSendResponse, error) { return nil, nil }\n' +
        'func (UnimplementedMsgServer) MultiSend(ctx context.Context, req *MsgMultiSend) (*MsgMultiSendResponse, error) { return nil, nil }\n' +
        'func (UnimplementedMsgServer) mustEmbedUnimplementedMsgServer() {}\n' +
        'func (UnimplementedMsgServer) testEmbeddedByValue() {}\n'
      );
      // Hand-written impl in a non-generated file — what an agent actually
      // wants the trace to land on.
      fs.writeFileSync(
        path.join(tmpDir, 'msg_server.go'),
        'package keeper\n\n' +
        'type msgServer struct{ k Keeper }\n\n' +
        'func (m msgServer) Send(ctx context.Context, req *MsgSend) (*MsgSendResponse, error) {\n' +
        '  return m.k.SendCoins(ctx, req.From, req.To, req.Amount)\n' +
        '}\n' +
        'func (m msgServer) MultiSend(ctx context.Context, req *MsgMultiSend) (*MsgMultiSendResponse, error) {\n' +
        '  return nil, nil\n' +
        '}\n'
      );

      let cg: CodeGraph | undefined;
      try {
        cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        const stubSend = cg
          .getNodesByKind('method')
          .find((n) => n.qualifiedName.endsWith('UnimplementedMsgServer::Send'));
        const implSend = cg
          .getNodesByKind('method')
          .find((n) => n.qualifiedName.endsWith('msgServer::Send'));
        expect(stubSend, 'UnimplementedMsgServer.Send should be indexed').toBeDefined();
        expect(implSend, 'msgServer.Send should be indexed').toBeDefined();

        const bridge = cg
          .getOutgoingEdges(stubSend!.id)
          .find((e) => e.target === implSend!.id && e.kind === 'calls');
        expect(bridge, 'stub Send should bridge to impl Send').toBeDefined();
        expect(bridge!.provenance).toBe('heuristic');
        expect((bridge!.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe(
          'go-grpc-stub-impl'
        );
      } finally {
        cg?.close();
      }
    });

    it('does not bridge to candidates living in another generated file', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-grpc-sib-'));
      // `*_grpc.pb.go` also contains a sibling `msgClient` struct that
      // happens to satisfy the same method set. We must NOT bridge to it —
      // it's not the hand-written impl, just the gRPC client wrapper.
      fs.writeFileSync(
        path.join(tmpDir, 'tx_grpc.pb.go'),
        'package banktypes\n\n' +
        'type UnimplementedMsgServer struct{}\n' +
        'func (UnimplementedMsgServer) Send() {}\n' +
        'func (UnimplementedMsgServer) MultiSend() {}\n\n' +
        'type msgClient struct{}\n' +
        'func (m msgClient) Send() {}\n' +
        'func (m msgClient) MultiSend() {}\n'
      );

      let cg: CodeGraph | undefined;
      try {
        cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        const stub = cg
          .getNodesByKind('struct')
          .find((n) => n.name === 'UnimplementedMsgServer');
        expect(stub).toBeDefined();
        const bridges = cg
          .getNodesByKind('method')
          .filter((n) => n.qualifiedName.endsWith('UnimplementedMsgServer::Send'))
          .flatMap((stubSend) => cg!.getOutgoingEdges(stubSend.id))
          .filter(
            (e) =>
              e.kind === 'calls' &&
              (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy ===
              'go-grpc-stub-impl',
          );
        expect(bridges, 'no bridge to msgClient (also generated)').toHaveLength(0);
      } finally {
        cg?.close();
      }
    });
  });
}
