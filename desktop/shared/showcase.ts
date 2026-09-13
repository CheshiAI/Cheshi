export const SHOWCASE_URLS = {
  gallery: 'https://developers.openai.com/showcase',
  submission: 'https://openai.com/form/showcase-submission/',
} as const;

export const SHOWCASE_CHANNELS = {
  view: 'cheshi:showcase:view',
  navigate: 'cheshi:showcase:navigate',
  state: 'cheshi:showcase:state',
} as const;

export type ShowcasePage = keyof typeof SHOWCASE_URLS;
export type ShowcaseAction = 'back' | 'forward' | 'reload' | 'home' | 'external';
export interface ShowcaseViewRequest {
  page: ShowcasePage;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  backgroundColor?: string;
}
export interface ShowcaseState {
  page: ShowcasePage;
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}
export interface ShowcaseApi {
  setView(request: ShowcaseViewRequest): Promise<void>;
  navigate(action: ShowcaseAction): Promise<void>;
  onState(handler: (state: ShowcaseState) => void): () => void;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid Showcase data.');
  return value as Record<string, unknown>;
}

function page(value: unknown): ShowcasePage {
  if (value !== 'gallery' && value !== 'submission') throw new TypeError('Invalid Showcase page.');
  return value;
}

function boolean(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid Showcase flag.');
  return value;
}

export function safeShowcaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function safeShowcaseBackgroundColor(value: unknown): string | null {
  return typeof value === 'string' && value.length === 7 && /^#[\da-f]{6}$/i.test(value) ? value : null;
}

export function parseShowcaseViewRequest(value: unknown): ShowcaseViewRequest {
  const input = record(value);
  const bounds = record(input.bounds);
  const dimension = (field: 'x' | 'y' | 'width' | 'height') => {
    const number = bounds[field];
    const minimum = field === 'x' || field === 'y' ? -100_000 : 0;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum || number > 100_000) {
      throw new TypeError('Invalid Showcase bounds.');
    }
    return number;
  };
  const result: ShowcaseViewRequest = { page: page(input.page), visible: boolean(input.visible),
    bounds: { x: dimension('x'), y: dimension('y'), width: dimension('width'), height: dimension('height') } };
  if (Object.hasOwn(input, 'backgroundColor')) {
    const backgroundColor = safeShowcaseBackgroundColor(input.backgroundColor);
    if (backgroundColor === null) throw new TypeError('Invalid Showcase background color.');
    result.backgroundColor = backgroundColor;
  }
  return result;
}

export function parseShowcaseAction(value: unknown): ShowcaseAction {
  if (value !== 'back' && value !== 'forward' && value !== 'reload' && value !== 'home' && value !== 'external') {
    throw new TypeError('Invalid Showcase action.');
  }
  return value;
}

export function parseShowcaseState(value: unknown): ShowcaseState {
  const input = record(value);
  const url = input.url === '' ? '' : safeShowcaseUrl(input.url);
  if (url === null || typeof input.title !== 'string' || input.title.length > 4096
    || (input.error !== null && (typeof input.error !== 'string' || input.error.length > 4096))) {
    throw new TypeError('Invalid Showcase state.');
  }
  return { page: page(input.page), url, title: input.title, loading: boolean(input.loading),
    error: input.error, canGoBack: boolean(input.canGoBack), canGoForward: boolean(input.canGoForward) };
}
