import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildCommitGraph, type GraphCommit } from '../frontend/src/features/git/gitCommitGraphLayout';
import { GitCommitGraph } from '../frontend/src/features/git/GitCommitGraph';

const commit = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });

test('draws a linear history with no imaginary edge before the tip or after the root', () => {
  const graph = buildCommitGraph([commit('tip', 'middle'), commit('middle', 'root'), commit('root')]);
  expect(graph.laneCount).toBe(1);
  expect(graph.rows.map(row => row.lane)).toEqual([0, 0, 0]);
  expect(graph.rows[0]!.edges.map(edge => edge.start)).toEqual(['node']);
  expect(graph.rows[1]!.edges.map(edge => [edge.start, edge.end])).toEqual([['top', 'node'], ['node', 'bottom']]);
  expect(graph.rows[2]!.edges.map(edge => edge.end)).toEqual(['node']);
});

test('splits a merge into distinct parent lanes and rejoins at their common ancestor', () => {
  const graph = buildCommitGraph([
    commit('merge', 'main', 'feature'), commit('feature', 'base'), commit('main', 'base'), commit('base'),
  ]);
  expect(graph.laneCount).toBe(2);
  expect(graph.rows[0]!.merge).toBe(true);
  expect(graph.rows[0]!.edges.map(edge => edge.to)).toEqual([0, 1]);
  expect(graph.rows[1]!.lane).toBe(1);
  expect(graph.rows[1]!.color).not.toBe(graph.rows[2]!.color);
  const join = graph.rows[2]!.edges.filter(edge => edge.end === 'bottom');
  expect(join).toHaveLength(2);
  expect(join.every(edge => edge.to === 0)).toBe(true);
  expect(graph.rows[3]!.lane).toBe(0);
  expect(graph.rows[3]!.edges).toHaveLength(1);
});

test('handles octopus merges, repeated parent references and parents already in a lane', () => {
  const graph = buildCommitGraph([
    commit('merge', 'a', 'b', 'c', 'a'), commit('a', 'b', 'base'),
    commit('b', 'base'), commit('c', 'base'), commit('base'),
  ]);
  expect(graph.laneCount).toBe(3);
  expect(graph.rows[0]!.edges).toHaveLength(3);
  expect(graph.rows[1]!.edges.filter(edge => edge.start === 'node')).toHaveLength(2);
  for (const row of graph.rows) {
    expect(row.edges.every(edge => edge.from >= 0 && edge.to >= 0)).toBe(true);
  }
  expect(graph.rows.at(-1)!.edges.every(edge => edge.end === 'node')).toBe(true);
});

test('keeps the exact parent connections across intervening commits and nested merges', () => {
  const commits = [commit('m', 'a', 'b'), commit('a', 'c', 'd'), commit('b', 'd'),
    commit('c', 'root'), commit('d', 'root'), commit('root')];
  const { rows } = buildCommitGraph(commits);
  for (const [index, entry] of commits.entries()) {
    const outgoing = rows[index]!.edges.filter(edge => edge.start === 'node');
    expect(outgoing).toHaveLength(entry.parents.length);
    for (const [parentIndex, hash] of entry.parents.entries()) {
      let lane = outgoing[parentIndex]!.to;
      let destination: string | undefined;
      for (const row of rows.slice(index + 1)) {
        const edge = row.edges.find(value => value.start === 'top' && value.from === lane);
        expect(edge).toBeDefined();
        if (edge!.end === 'node') { destination = row.hash; break; }
        lane = edge!.to;
      }
      expect(destination).toBe(hash);
    }
  }
});

test('does not connect disconnected roots and preserves continuations past the log limit', () => {
  const roots = buildCommitGraph([commit('one'), commit('two')]);
  expect(roots.rows.every(row => row.edges.length === 0)).toBe(true);
  const truncated = buildCommitGraph([commit('merge', 'outside-main', 'outside-feature')]);
  expect(truncated.rows[0]!.edges.every(edge => edge.end === 'bottom')).toBe(true);
  expect(truncated.laneCount).toBe(2);
  expect(buildCommitGraph([]).rows).toEqual([]);
});

test('renders a separate colored path for each merge parent and a node for every row', () => {
  const graph = buildCommitGraph([commit('merge', 'a', 'b')]);
  const html = renderToStaticMarkup(<GitCommitGraph row={graph.rows[0]!} laneCount={graph.laneCount} />);
  expect(html.match(/<path /g)).toHaveLength(2);
  expect(html.match(/<circle /g)).toHaveLength(1);
  expect(html).toContain('viewBox="0 0 32 54"');
  expect(html).toContain('aria-hidden="true"');
});
