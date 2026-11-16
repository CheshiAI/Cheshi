const duration = 2400;
const maxPulses = 6;
const columns = 84;
const rows = 56;
const cellWidth = 6;
const cellHeight = 9;
const characters = 'cheshi0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

interface LogoPulse { x: number; y: number; started: number }

/** Rasterize the existing logo once into a reusable, transparent ASCII texture. */
function logoTexture(document: Document, image: HTMLImageElement, color: string, font: string) {
  const sample = document.createElement('canvas');
  sample.width = columns;
  sample.height = rows;
  const sampler = sample.getContext('2d');
  if (!sampler) return null;
  sampler.drawImage(image, 0, 0, columns, rows);
  const pixels = sampler.getImageData(0, 0, columns, rows).data;
  const texture = document.createElement('canvas');
  texture.width = columns * cellWidth;
  texture.height = rows * cellHeight;
  const context = texture.getContext('2d');
  if (!context) return null;
  context.font = `8px ${font}`;
  context.textBaseline = 'top';
  context.fillStyle = color;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const offset = (y * columns + x) * 4;
      const brightness = (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!) / (3 * 255);
      const coverage = pixels[offset + 3]! / 255 * brightness;
      if (coverage < .15) continue;
      const seed = (x * 17 + y * 31) % characters.length;
      context.globalAlpha = coverage * (.45 + (seed % 7) / 12);
      context.fillText(characters[seed]!, x * cellWidth, y * cellHeight);
    }
  }
  return texture;
}

/** Own all drawing and listeners; idle or hidden surfaces do not run an animation loop. */
export function mountCheshiLogoEffect(host: HTMLElement, canvas: HTMLCanvasElement, logoUrl: string) {
  const document = host.ownerDocument;
  const view = document.defaultView;
  const context = canvas.getContext('2d');
  if (!view || !context) return () => {};
  const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const image = new view.Image();
  let texture: HTMLCanvasElement | null = null;
  let pulses: LogoPulse[] = [];
  let frame: number | null = null;
  let visible = true;
  let disposed = false;
  let width = 0;
  let height = 0;
  let density = 1;

  const clear = () => context.clearRect(0, 0, width, height);
  const stop = () => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    pulses = [];
    clear();
  };
  const canDraw = () => !disposed && visible && !document.hidden && !motion.matches
    && width > 0 && height > 0 && host.getClientRects().length > 0;
  const draw = (now: number) => {
    frame = null;
    if (!canDraw()) { stop(); return; }
    clear();
    pulses = pulses.filter(pulse => now - pulse.started < duration);
    const size = Math.min(520, Math.max(220, Math.min(width, height) * .8));
    for (const pulse of pulses) {
      const progress = Math.max(0, (now - pulse.started) / duration);
      const spread = 1 - (1 - progress) ** 3;
      const extent = size * (.25 + spread * 1.35);
      context.globalAlpha = Math.min(1, progress / .08) * (1 - progress) ** 1.5 * .65;
      if (texture) context.drawImage(texture, pulse.x * width - extent / 2, pulse.y * height - extent / 2, extent, extent);
    }
    context.globalAlpha = 1;
    if (pulses.length) frame = view.requestAnimationFrame(draw);
  };
  const start = () => {
    if (texture && pulses.length && frame === null && canDraw()) frame = view.requestAnimationFrame(draw);
  };
  const resize = () => {
    const rect = host.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    // Bound backing storage even on very large, high-density displays.
    density = Math.min(view.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / Math.max(1, width * height)));
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    context.setTransform(density, 0, 0, density, 0, 0);
    if (!canDraw()) stop();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || event.defaultPrevented || !canDraw()) return;
    const rect = host.getBoundingClientRect();
    pulses = [...pulses.slice(-(maxPulses - 1)), {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      started: view.performance.now(),
    }];
    start();
  };
  const visibilityChanged = () => { if (!canDraw()) stop(); };
  image.onload = () => {
    if (disposed) return;
    const style = view.getComputedStyle(canvas);
    texture = logoTexture(document, image, style.color, style.fontFamily);
    start();
  };
  image.onerror = stop;
  const resizeObserver = new view.ResizeObserver(resize);
  const intersectionObserver = new view.IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    visibilityChanged();
  });
  resizeObserver.observe(host);
  intersectionObserver.observe(host);
  host.addEventListener('pointerdown', pointerDown);
  document.addEventListener('visibilitychange', visibilityChanged);
  view.addEventListener('blur', stop);
  motion.addEventListener('change', visibilityChanged);
  resize();
  image.src = logoUrl;

  return () => {
    disposed = true;
    stop();
    image.onload = null;
    image.onerror = null;
    texture = null;
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    host.removeEventListener('pointerdown', pointerDown);
    document.removeEventListener('visibilitychange', visibilityChanged);
    view.removeEventListener('blur', stop);
    motion.removeEventListener('change', visibilityChanged);
  };
}
