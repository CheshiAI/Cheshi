export interface GraphCommit { hash: string; parents: readonly string[] }
interface Lane { hash: string; color: number }
export interface CommitGraphEdge {
  from: number;
  to: number;
  start: 'top' | 'node';
  end: 'node' | 'bottom';
  color: number;
}
export interface CommitGraphRow {
  hash: string;
  lane: number;
  color: number;
  merge: boolean;
  edges: CommitGraphEdge[];
}

/** Consumes child-before-parent Git log order. Pending parents occupy lanes between rows. */
export function buildCommitGraph(commits: readonly GraphCommit[]) {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let laneCount = 1;
  const rows: CommitGraphRow[] = [];
  for (const commit of commits) {
    let lane = lanes.findIndex(entry => entry.hash === commit.hash);
    const incoming = lane !== -1;
    if (!incoming) {
      lane = lanes.length;
      lanes = [...lanes, { hash: commit.hash, color: nextColor++ }];
    }
    const node = lanes[lane]!;
    const after = lanes.filter((_, index) => index !== lane);
    const parents = [...new Set(commit.parents ?? [])];
    let insertion = lane;
    for (const [index, hash] of parents.entries()) {
      if (after.some(entry => entry.hash === hash)) continue;
      after.splice(Math.min(insertion++, after.length), 0, {
        hash, color: index === 0 ? node.color : nextColor++,
      });
    }
    const edges: CommitGraphEdge[] = [];
    lanes.forEach((entry, index) => {
      if (index === lane) {
        if (incoming) edges.push({ from: lane, to: lane, start: 'top', end: 'node', color: node.color });
      } else {
        edges.push({ from: index, to: after.findIndex(target => target.hash === entry.hash),
          start: 'top', end: 'bottom', color: entry.color });
      }
    });
    for (const hash of parents) {
      const target = after.findIndex(entry => entry.hash === hash);
      edges.push({ from: lane, to: target, start: 'node', end: 'bottom', color: after[target]!.color });
    }
    laneCount = Math.max(laneCount, lanes.length, after.length);
    rows.push({ hash: commit.hash, lane, color: node.color, merge: parents.length > 1, edges });
    lanes = after;
  }
  return { rows, laneCount };
}
