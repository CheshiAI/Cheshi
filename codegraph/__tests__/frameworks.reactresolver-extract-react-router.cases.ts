import { reactResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerReactresolverExtractReactRouterTests(): void {


  describe('reactResolver.extract — React Router', () => {
    it('extracts a v6 Route path with an element', () => {
      const src = /* language=TEXT */ `<Route path="/users" element={<UsersPage/>}/>`;
      const { nodes, references } = reactResolver.extract!('App.tsx', src);
      const route = nodes.find((n) => n.kind === 'route');
      expect(route?.name).toBe('/users');
      expect(references[0]?.referenceName).toBe('UsersPage');
    });

    it('extracts a v5 Route path with a component in any attribute order', () => {
      const src = /* language=TEXT */ `<Route exact path="/login" component={Login} />`;
      const { nodes, references } = reactResolver.extract!('App.jsx', src);
      const route = nodes.find((n) => n.kind === 'route');
      expect(route?.name).toBe('/login');
      expect(references[0]?.referenceName).toBe('Login');
    });

    it('does not treat the Routes container as a route', () => {
      const src = /* language=TEXT */ `<Routes><Route path="/x" element={<X/>}/></Routes>`;
      const routes = reactResolver.extract!('App.tsx', src).nodes.filter((n) => n.kind === 'route');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.name).toBe('/x');
    });

    it('extracts createBrowserRouter object routes ({ path, element/Component })', () => {
      const src = `const router = createBrowserRouter([
      { path: "/dashboard", element: <Dashboard /> },
      { path: "/login", Component: Login },
    ]);`;
      const { nodes, references } = reactResolver.extract!('router.tsx', src);
      const routes = nodes.filter((n) => n.kind === 'route');
      expect(routes.map((n) => n.name).sort()).toEqual(['/dashboard', '/login']);
      expect(references.map((r) => r.referenceName).sort()).toEqual(['Dashboard', 'Login']);
    });

    it('does not treat config files or a nextjs-pages dir as Next.js routes', () => {
      const cfg = reactResolver.extract!('apps/nextjs-pages/next.config.mjs', 'export default {}');
      expect(cfg.nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
      const vite = reactResolver.extract!('src/pages/vite.config.ts', 'export default {}');
      expect(vite.nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
      // a real page still works
      const page = reactResolver.extract!('src/pages/about.tsx', 'export default function About(){return null}');
      expect(page.nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['/about']);
    });
  });
}
