import type { CSSProperties } from 'react';

type ElectronCSSProperties = CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag';
};

export const draggableWindowRegionStyle: ElectronCSSProperties = {
  WebkitAppRegion: 'drag',
};

export const nonDraggableWindowRegionStyle: ElectronCSSProperties = {
  WebkitAppRegion: 'no-drag',
};
