import { extractFromSource } from '../src/extraction';
import { detectLanguage, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerAstroExtractionTests(): void {


  describe('Astro Extraction', () => {
    it('should detect Astro files', () => {
      expect(detectLanguage('src/pages/index.astro')).toBe('astro');
      expect(detectLanguage('Layout.astro')).toBe('astro');
      expect(isLanguageSupported('astro')).toBe(true);
    });

    it('should extract component node from an .astro file', () => {
      const code = /* language=TEXT */ `---
const title = 'Hello';
---
<h1>{title}</h1>
`;
      const result = extractFromSource('Card.astro', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();
      expect(componentNode?.name).toBe('Card');
      expect(componentNode?.language).toBe('astro');
      expect(componentNode?.isExported).toBe(true);
    });

    it('should extract frontmatter symbols with correct line numbers (#768)', () => {
      const code = /* language=TEXT */ `---
import { formatDate } from '../utils/format';

function getIconNode(name: string): string {
  return name;
}

const { title } = Astro.props;
---
<span>{title}</span>
`;
      const result = extractFromSource('navs.astro', code);

      // The #768 repro: a function defined in frontmatter must be found
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'getIconNode');
      expect(fn).toBeDefined();
      expect(fn?.language).toBe('astro');
      expect(fn?.startLine).toBe(4);

      const imp = result.nodes.find((n) => n.kind === 'import');
      expect(imp).toBeDefined();
      expect(imp?.startLine).toBe(2);
    });

    it('should extract exported getStaticPaths from frontmatter', () => {
      const code = /* language=TEXT */ `---
export async function getStaticPaths() {
  return [];
}
const { slug } = Astro.params;
---
<p>{slug}</p>
`;
      const result = extractFromSource('[slug].astro', code);

      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'getStaticPaths');
      expect(fn).toBeDefined();
      expect(fn?.isExported).toBe(true);
    });

    it('should extract calls from template expressions', () => {
      const code = /* language=TEXT */ `---
import { formatDate } from '../utils/format';
const date = new Date();
---
<time>{formatDate(date)}</time>
`;
      const result = extractFromSource('Stamp.astro', code);

      const call = result.unresolvedReferences.find(
        (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'formatDate' && ref.line === 5
      );
      expect(call).toBeDefined();
    });

    it('should extract calls from a multiline expression opening line', () => {
      const code = /* language=TEXT */ `---
const posts = [];
---
<ul>
  {posts.map((post) => (
    <li>{render(post)}</li>
  ))}
</ul>
`;
      const result = extractFromSource('List.astro', code);

      const mapCall = result.unresolvedReferences.find(
        (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'posts.map'
      );
      expect(mapCall).toBeDefined();
      const innerCall = result.unresolvedReferences.find(
        (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'render'
      );
      expect(innerCall).toBeDefined();
    });

    it('should extract PascalCase component usages from the template', () => {
      const code = /* language=TEXT */ `---
import Layout from '../layouts/Layout.astro';
import PostCard from '../components/PostCard.astro';
---
<Layout title="Home">
  <PostCard />
  <Fragment slot="head" />
  <div class="plain-html" />
</Layout>
`;
      const result = extractFromSource('index.astro', code);

      const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
      const names = refs.map((r) => r.referenceName);
      expect(names).toContain('Layout');
      expect(names).toContain('PostCard');
      // Astro built-ins and lowercase HTML are not component references
      expect(names).not.toContain('Fragment');
      expect(names).not.toContain('div');
    });

    it('should not extract template patterns from frontmatter, script, or style content', () => {
      const code = /* language=TEXT */ `---
// <FakeComponent /> inside frontmatter comment
const x = { y: maybeCall(1) };
---
<div>real</div>
<script>
  const z = { w: scriptCall(2) };
</script>
<style>
  .a { color: red; }
</style>
`;
      const result = extractFromSource('Guard.astro', code);

      const templateRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'references' && r.referenceName === 'FakeComponent'
      );
      expect(templateRefs).toHaveLength(0);

      // maybeCall/scriptCall come from the delegated TS extraction (once),
      // not double-counted by the template scanner
      const maybeCalls = result.unresolvedReferences.filter(
        (r) => r.referenceName === 'maybeCall' && r.referenceKind === 'calls'
      );
      expect(maybeCalls.length).toBeLessThanOrEqual(1);
    });

    it('should extract Astro script block symbols with correct line numbers', () => {
      const code = /* language=TEXT */ `---
const a = 1;
---
<div>hi</div>
<script>
function trackView(page: string) {
  console.log(page);
}
</script>
`;
      const result = extractFromSource('Tracker.astro', code);

      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'trackView');
      expect(fn).toBeDefined();
      expect(fn?.startLine).toBe(6);
      expect(fn?.language).toBe('astro');
    });

    it('should create component node for a frontmatter-less template-only file', () => {
      const code = /* language=TEXT */ `<div>Static content</div>
`;
      const result = extractFromSource('Static.astro', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();
      expect(componentNode?.name).toBe('Static');
      expect(componentNode?.language).toBe('astro');
    });

    it('should treat an unclosed frontmatter fence as no frontmatter', () => {
      const code = /* language=TEXT */ `---
const broken = true;
<div>never closed</div>
`;
      const result = extractFromSource('Broken.astro', code);

      // No TS delegation happened (the fence never closes), but the component
      // node still exists and nothing throws.
      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();
      expect(result.nodes.find((n) => n.name === 'broken')).toBeUndefined();
    });

    it('should create containment edges from component to frontmatter nodes', () => {
      const code = /* language=TEXT */ `---
const value = 42;
---
<div>{value}</div>
`;
      const result = extractFromSource('Contained.astro', code);

      const componentNode = result.nodes.find((n) => n.kind === 'component');
      expect(componentNode).toBeDefined();

      const containEdges = result.edges.filter(
        (e) => e.source === componentNode!.id && e.kind === 'contains'
      );
      expect(containEdges.length).toBeGreaterThan(0);
    });
  });
}
