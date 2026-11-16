export const APPEARANCE_CHANNELS = {
  get: 'cheshi:appearance:get', set: 'cheshi:appearance:set', changed: 'cheshi:appearance:changed',
} as const;

export interface WindowAppearance {
  enabled: boolean;
  opacity: number;
  blurRadius: number;
  mainPaneGlass: boolean;
}
export interface WindowAppearanceState {
  preferences: WindowAppearance;
  supported: boolean;
  active: boolean;
  error: string | null;
}
export interface WindowAppearanceApi {
  get(): Promise<WindowAppearanceState>;
  set(value: WindowAppearance): Promise<WindowAppearanceState>;
  onChanged(handler: (state: WindowAppearanceState) => void): () => void;
}
export const DEFAULT_WINDOW_APPEARANCE: Readonly<WindowAppearance> = {
  enabled: true, opacity: 0.75, blurRadius: 16, mainPaneGlass: true,
};

export function parseWindowAppearance(value: unknown): WindowAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid appearance settings.');
  const item = value as Record<string, unknown>;
  if ((item.enabled !== true && item.enabled !== false) || (item.mainPaneGlass !== true && item.mainPaneGlass !== false)
    || typeof item.opacity !== 'number' || !Number.isFinite(item.opacity) || item.opacity < 0.15 || item.opacity > 1
    || typeof item.blurRadius !== 'number' || !Number.isInteger(item.blurRadius) || item.blurRadius < 0 || item.blurRadius > 64) {
    throw new TypeError('Invalid appearance settings.');
  }
  return { enabled: item.enabled, opacity: item.opacity, blurRadius: item.blurRadius, mainPaneGlass: item.mainPaneGlass };
}

export function parseWindowAppearanceState(value: unknown): WindowAppearanceState {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid appearance state.');
  const item = value as Record<string, unknown>;
  if ((item.supported !== true && item.supported !== false) || (item.active !== true && item.active !== false)
    || (item.error !== null && (typeof item.error !== 'string' || item.error.length > 500))) {
    throw new TypeError('Invalid appearance state.');
  }
  return { preferences: parseWindowAppearance(item.preferences), supported: item.supported, active: item.active, error: item.error };
}
