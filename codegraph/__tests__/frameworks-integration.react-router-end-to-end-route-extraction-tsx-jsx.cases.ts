import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerReactRouterEndToEndRouteExtractionTsxJsxTests(): void {


  describe('React Router end-to-end route extraction (.tsx/.jsx)', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    // Regression for the resolver language-gate bug: the `react` resolver's
    // `extract()` was filtered out of the .tsx/.jsx grammars, so `<Route>` routes
    // — which only live in JSX files — were never indexed through the real
    // indexing path (the unit tests call extract() directly and so missed this).
    it('indexes React Router element routes from a TSX file and links them to the component', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-'));
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        '{"dependencies":{"react":"^18.0.0","react-router-dom":"^6.0.0"}}'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'Home.tsx'),
        'export function Home() { return null; }\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'routes.tsx'),
      /* language=TEXT */ `import { Routes, Route } from 'react-router-dom';
import { Home } from './Home';
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/home" element={<Home/>} />
    </Routes>
  );
}
`
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();
      try {
        // The route node from the .tsx file exists (the bug: it didn't).
        const route = cg.getNodesByKind('route').find((n) => n.name === '/home');
        expect(route, '/home route from .tsx should be indexed').toBeDefined();

        // ...and it links to the Home component.
        const home = cg.getNodesByName('Home').find((n) => n.kind === 'function');
        expect(home).toBeDefined();
        const toHome = cg.getOutgoingEdges(route!.id).find((e) => e.target === home!.id);
        expect(toHome, 'route → Home component edge').toBeDefined();
      } finally {
        cg.close();
      }
    });
  });
}
