import { AGENT_AVATAR_COLORS, defaultAgentAvatar } from '../../../../shared/agent-avatar';
import type { AgentAvatarValue } from '../../../../shared/agent-avatar';
import { agentAvatarPixels } from './agentAvatarPixels';
import styles from './AgentAvatar.module.css';

export function AgentAvatar({ avatar, id = '', preview = false }: { avatar?: AgentAvatarValue; id?: string; preview?: boolean }) {
  const value = avatar ?? defaultAgentAvatar(id);
  const pixels = agentAvatarPixels[value.character].flatMap((row, y) => Array.from({ length: 11 }, (_, x) =>
    row & (1 << (10 - x)) ? { x: x + 1, y: y + 1 } : null).filter(pixel => pixel !== null));
  const xs = pixels.map(pixel => pixel.x), ys = pixels.map(pixel => pixel.y);
  const centerX = (Math.min(...xs) + Math.max(...xs) + 1) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys) + 1) / 2;
  const path = pixels.map(({ x, y }) => `M${x} ${y}h1v1h-1z`).join('');
  // Move the viewport to the painted bounds; retain the original pixel scale and geometry.
  const viewBox = `${centerX - 6.5} ${centerY - 6.5} 13 13`;
  return <span className={styles.avatar} data-preview={preview || undefined} data-agent-avatar={`${value.character}:${value.color}`} aria-hidden="true">
    <svg viewBox={viewBox} shapeRendering="crispEdges" focusable="false" aria-hidden="true">
      <path d={path} fill={AGENT_AVATAR_COLORS[value.color]} />
    </svg>
  </span>;
}
