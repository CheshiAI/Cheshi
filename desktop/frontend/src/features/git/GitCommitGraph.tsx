import type { CommitGraphRow } from './gitCommitGraphLayout';
import styles from './GitWorkspace.module.css';

const colors = ['#83adc1', '#a18acb', '#65aa96', '#c58b65', '#c77499', '#b5ab69'];
const color = (index: number) => colors[index % colors.length];
const x = (lane: number) => 8 + lane * 16;
const rowHeight = 48;
const nodeY = rowHeight / 2;

export function GitCommitGraph({ row, laneCount }: { row: CommitGraphRow; laneCount: number }) {
  const width = laneCount * 16;
  return <svg className={styles.commitGraph} style={{ width }} width={width} height={rowHeight}
    viewBox={`0 0 ${width} ${rowHeight}`} aria-hidden="true" focusable="false">
    {row.edges.map((edge, index) => {
      const y1 = edge.start === 'top' ? 0 : nodeY;
      const y2 = edge.end === 'bottom' ? rowHeight : nodeY;
      const middle = (y1 + y2) / 2;
      return <path key={index} fill="none" stroke={color(edge.color)} strokeWidth={1.5}
        d={`M ${x(edge.from)} ${y1} C ${x(edge.from)} ${middle}, ${x(edge.to)} ${middle}, ${x(edge.to)} ${y2}`} />;
    })}
    <circle cx={x(row.lane)} cy={nodeY} r={4} stroke={color(row.color)} strokeWidth={2}
      fill={row.merge ? 'none' : color(row.color)} />
  </svg>;
}
