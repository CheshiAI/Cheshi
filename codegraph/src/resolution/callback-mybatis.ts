import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import type { MaybeYield } from './cooperative-yield';

/**
 * MyBatis: link a Java mapper interface method to the XML statement that holds
 * its SQL. The XML extractor (`src/extraction/mybatis-extractor.ts`) qualifies
 * each `<select|insert|update|delete|sql id="X">` as `<namespace>::<id>` where
 * `<namespace>` is the Java FQN of the mapper interface. A Java method's
 * qualifiedName ends with `<ClassName>::<methodName>`, so we suffix-match the
 * last two segments of the XML qualified name to find a unique Java method by
 * `<ClassName>::<methodName>` (`ClassName` = last dotted segment of the XML
 * namespace). Cross-mapper `<include refid="other.X">` references go through
 * the normal qualified-name resolver — only the Java↔XML bridge is synthetic.
 *
 * Precision over recall: ambiguous mappers (multiple Java classes with the
 * same simple name) are dropped. We need-not bridge by package because Java
 * mapper interfaces are typically uniquely named within a project.
 */
export async function mybatisJavaXmlEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  let scanned255 = 0;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // Collect the XML side FIRST (mapper `<select id=…>` statements extracted as
  // xml-language method nodes): if the project has none — every Java+XML repo
  // that doesn't use MyBatis — return before paying the full java-method
  // stream below. Same rowid stream order as matching inline, so the edge
  // output is byte-identical when mappers do exist.
  const xmlMethods: Node[] = [];
  for (const m of queries.iterateNodesByKind('method')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (m.language === 'xml') xmlMethods.push(m);
  }
  if (xmlMethods.length === 0) return edges;

  // Index Java methods by `<ClassName>::<methodName>` for O(1) lookup.
  const javaIndex = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKind('method')) {
    if ((++scanned255 & 63) === 0) await onYield();
    if (m.language !== 'java' && m.language !== 'kotlin') continue;
    const parts = m.qualifiedName.split('::');
    const last = parts[parts.length - 1];
    const cls = parts[parts.length - 2];
    if (!last || !cls) continue;
    const key = `${cls}::${last}`;
    const arr = javaIndex.get(key);
    if (arr) arr.push(m); else javaIndex.set(key, [m]);
  }

  for (const xml of xmlMethods) {
    if ((++scanned255 & 63) === 0) await onYield();
    // Qualified name: `<namespace>::<id>`. Extract the simple class name.
    const colonIdx = xml.qualifiedName.lastIndexOf('::');
    if (colonIdx < 0) continue;
    const namespace = xml.qualifiedName.slice(0, colonIdx);
    const id = xml.qualifiedName.slice(colonIdx + 2);
    if (!namespace || !id) continue;
    const dotIdx = namespace.lastIndexOf('.');
    const className = dotIdx >= 0 ? namespace.slice(dotIdx + 1) : namespace;
    const candidates = javaIndex.get(`${className}::${id}`);
    if (!candidates || candidates.length === 0) continue;
    // Drop ambiguous matches (multiple same-name classes); the user can
    // disambiguate by adding the package-suffix match in a future enhancement.
    if (candidates.length > 1) continue;
    const java = candidates[0]!;
    const key = `${java.id}>${xml.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: java.id,
      target: xml.id,
      kind: 'calls',
      line: java.startLine,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'mybatis-java-xml',
        via: `${className}.${id}`,
        registeredAt: `${xml.filePath}:${xml.startLine}`,
      },
    });
  }
  return edges;
}
