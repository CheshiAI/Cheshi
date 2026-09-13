import { goframeResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerGoframeresolverTests(): void {


  describe('goframeResolver', () => {
    it('detects GoFrame from a gogf/gf dependency in go.mod', () => {
      const ctx: any = {
        readFile: (f: string) =>
          f === 'go.mod' ? 'module example.com/app\nrequire github.com/gogf/gf/v2 v2.7.0\n' : null,
      };
      expect(goframeResolver.detect(ctx)).toBe(true);
      const noGf: any = { readFile: (f: string) => (f === 'go.mod' ? 'module example.com/app\n' : null) };
      expect(goframeResolver.detect(noGf)).toBe(false);
    });

    it('extracts a route node from a g.Meta request struct (method upper-cased)', () => {
      const src = `package v1
import "github.com/gogf/gf/v2/frame/g"
type SignInReq struct {
	g.Meta   \`path:"/user/sign-in" method:"post" tags:"User" summary:"Sign in"\`
	Passport string
}
type SignInRes struct{}
`;
      const { nodes } = goframeResolver.extract!('api/user/v1/user_sign_in.go', src);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].kind).toBe('route');
      expect(nodes[0].name).toBe('POST /user/sign-in');
      // The package-qualified request type is encoded for the synthesizer join.
      expect(nodes[0].qualifiedName).toContain('::goframe-route:v1.SignInReq');
    });

    it('is independent of g.Meta tag attribute order', () => {
      const src = `type DeptSearchReq struct {
	g.Meta \`path:"/dept/list" tags:"Dept" method:"get" summary:"列表"\`
}`;
      const { nodes } = goframeResolver.extract!('api/system/dept.go', src);
      expect(nodes[0].name).toBe('GET /dept/list');
      expect(nodes[0].qualifiedName).toContain('::goframe-route:DeptSearchReq');
    });

    it('skips a response g.Meta that has no path (mime-only) and other non-route metadata', () => {
      const src = `type ListRes struct {
	g.Meta \`mime:"application/json"\`
	Items []string
}`;
      const { nodes } = goframeResolver.extract!('api/x.go', src);
      expect(nodes).toHaveLength(0);
    });

    it('defaults method to ANY when method: is omitted', () => {
      const src = `type PingReq struct {
	g.Meta \`path:"/ping"\`
}`;
      const { nodes } = goframeResolver.extract!('api/ping.go', src);
      expect(nodes[0].name).toBe('ANY /ping');
    });

    it('extracts every request struct in a multi-route api file', () => {
      const src = `type DeptListReq struct { g.Meta \`path:"/dept/list" method:"get"\` }
type DeptListRes struct { g.Meta \`mime:"application/json"\` }
type DeptAddReq struct { g.Meta \`path:"/dept/add" method:"post"\` }
type DeptAddRes struct {}
`;
      const { nodes } = goframeResolver.extract!('api/dept.go', src);
      expect(nodes.map((n) => n.name).sort()).toEqual(['GET /dept/list', 'POST /dept/add']);
    });

    it('returns nothing for a non-go file or a file without g.Meta', () => {
      expect(goframeResolver.extract!('main.ts', 'const x = 1').nodes).toHaveLength(0);
      expect(goframeResolver.extract!('main.go', 'package main\nfunc main() {}\n').nodes).toHaveLength(0);
    });
  });
}
