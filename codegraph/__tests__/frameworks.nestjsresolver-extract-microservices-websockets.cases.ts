import { nestjsResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerNestjsresolverExtractMicroservicesWebsocketsTests(): void {


  describe('nestjsResolver.extract — microservices & websockets', () => {
    it('extracts @MessagePattern and @EventPattern handlers', () => {
      const src = `
@Controller()
export class MathController {
  @MessagePattern({ cmd: 'sum' })
  accumulate(data: number[]) {}

  @EventPattern('user.created')
  handleUserCreated(data: any) {}
}
`;
      const { nodes, references } = nestjsResolver.extract!('math.controller.ts', src);
      expect(nodes.map((n) => n.name)).toEqual(['MESSAGE sum', 'EVENT user.created']);
      expect(references.map((r) => r.referenceName)).toEqual(['accumulate', 'handleUserCreated']);
    });

    it('extracts @SubscribeMessage handlers with the gateway namespace', () => {
      const src = `
@WebSocketGateway({ namespace: 'chat' })
export class ChatGateway {
  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: string) {}
}
`;
      const { nodes, references } = nestjsResolver.extract!('chat.gateway.ts', src);
      expect(nodes[0].name).toBe('WS chat:message');
      expect(references[0].referenceName).toBe('handleMessage');
    });

    it('extracts @SubscribeMessage without a namespace', () => {
      const src = `
@WebSocketGateway()
export class EventsGateway {
  @SubscribeMessage('events')
  onEvent() {}
}
`;
      const { nodes } = nestjsResolver.extract!('events.gateway.ts', src);
      expect(nodes[0].name).toBe('WS events');
    });

    it('returns empty for a non-JS/TS file', () => {
      const { nodes, references } = nestjsResolver.extract!('thing.py', '@Controller("x")');
      expect(nodes).toEqual([]);
      expect(references).toEqual([]);
    });
  });
}
