import { astroResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerAstroresolverExtractSrcPagesFileBasedRoutingTests(): void {


  describe('astroResolver.extract — src/pages file-based routing', () => {
    const routeNames = (filePath: string): string[] =>
      astroResolver.extract!(filePath, '').nodes.filter((n) => n.kind === 'route').map((n) => n.name);

    it('maps index.astro to /', () => {
      expect(routeNames('src/pages/index.astro')).toEqual(['/']);
    });

    it('maps nested index and plain pages', () => {
      expect(routeNames('src/pages/blog/index.astro')).toEqual(['/blog']);
      expect(routeNames('src/pages/about.astro')).toEqual(['/about']);
    });

    it('converts [param] and [...rest] syntax', () => {
      expect(routeNames('src/pages/blog/[slug].astro')).toEqual(['/blog/:slug']);
      expect(routeNames('src/pages/[...path].astro')).toEqual(['/*path']);
    });

    it('maps .ts endpoints under src/pages to routes', () => {
      expect(routeNames('src/pages/api/posts.ts')).toEqual(['/api/posts']);
      expect(routeNames('src/pages/rss.xml.js')).toEqual(['/rss.xml']);
    });

    it('excludes underscore-prefixed segments and config files', () => {
      expect(routeNames('src/pages/_partial.astro')).toEqual([]);
      expect(routeNames('src/pages/blog/_components/Card.astro')).toEqual([]);
      expect(routeNames('src/pages/vite.config.ts')).toEqual([]);
    });

    it('ignores .astro files outside src/pages', () => {
      expect(routeNames('src/components/Button.astro')).toEqual([]);
      expect(routeNames('docs/pages/guide.astro')).toEqual([]);
    });
  });
}
