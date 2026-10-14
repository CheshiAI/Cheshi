/** Sample cubic-bezier(.42, 0, .58, 1) without replacing its acceleration curve. */
export function createSteppedEaseInOut(steps: number): string {
  if (!Number.isInteger(steps) || steps < 1) throw new RangeError('Expected a positive step count');
  const stops: string[] = [];
  for (let index = 0; index < steps; index++) {
    const progress = index / steps;
    let low = 0, high = 1;
    // Invert the Bézier x coordinate to find y at this elapsed-time fraction.
    for (let iteration = 0; iteration < 24; iteration++) {
      const t = (low + high) / 2;
      const x = 3 * (1 - t) ** 2 * t * .42 + 3 * (1 - t) * t ** 2 * .58 + t ** 3;
      if (x < progress) low = t; else high = t;
    }
    const t = (low + high) / 2;
    const value = (3 * (1 - t) * t ** 2 + t ** 3).toFixed(6);
    // Repeated positions create a jump; each flat segment lasts exactly one frame.
    stops.push(`${value} ${(progress * 100).toFixed(6)}% ${((index + 1) / steps * 100).toFixed(6)}%`);
  }
  return `linear(${stops.join(', ')}, 1 100%)`;
}
