import { expect, test } from 'bun:test';
import { regionalBlurMask, regionalBlurMaskImage, type BlurSurface } from '../frontend/src/shared/ui/regionalBlurGeometry';

const bounds = { x: 100, y: 50, width: 800, height: 600 };
const surface: BlurSurface = { x: 140, y: 500, width: 720, height: 128, corners: ['16px', '16px', '0px', '0px'] };
const paths = (svg: string) => [...svg.matchAll(/<path[^>]*\/>/g)].map(match => match[0]);

test('a composer mask retains exactly the same paths while omitting empty scene pixels', () => {
  const full = regionalBlurMask(bounds, 800, 600, [surface])!;
  const image = regionalBlurMaskImage(bounds, 800, 600, [surface])!;
  expect(image).toMatchObject({ x: 40, y: 450, width: 720, height: 128 });
  expect(image.svg).toContain('viewBox="40 450 720 128"');
  expect(paths(image.svg)).toEqual(paths(full));
  expect(image.width * image.height).toBeLessThan(800 * 600 / 4);
});

test('nested surfaces share a cropped union and offscreen corners keep their original geometry', () => {
  const offscreen = { ...surface, x: 60, y: 20, width: 200, height: 100 };
  const nested = { ...surface, x: 810, y: 570, width: 180, height: 140 };
  const hidden = { ...surface, x: 1000 };
  const surfaces = [offscreen, nested, hidden];
  const image = regionalBlurMaskImage(bounds, 800, 600, surfaces)!;
  expect(image).toMatchObject({ x: 0, y: 0, width: 800, height: 600 });
  expect(paths(image.svg)).toEqual(paths(regionalBlurMask(bounds, 800, 600, surfaces)!));
  expect(paths(image.svg)).toHaveLength(2);
  expect(image.svg).toContain('M-24 -30');
});

test('zoomed and fractional panel edges use outward pixel rounding without stretching paths', () => {
  const fractional: BlurSurface = { ...surface, x: 130.25, y: 90.75, width: 100.5, height: 80.25,
    corners: ['20% 10%', '12px', '0px', '4px'] };
  const image = regionalBlurMaskImage(bounds, 1200, 900, [fractional])!;
  expect(image).toMatchObject({ x: 45, y: 61, width: 152, height: 121 });
  expect(paths(image.svg)).toEqual(paths(regionalBlurMask(bounds, 1200, 900, [fractional])!));
  expect(image.svg).toContain('viewBox="45 61 152 121"');
});

test('empty, offscreen and zero-size surfaces do not allocate a mask', () => {
  for (const surfaces of [[], [{ ...surface, x: 1000 }], [{ ...surface, width: 0 }]]) {
    expect(regionalBlurMaskImage(bounds, 800, 600, surfaces)).toBeNull();
  }
  expect(regionalBlurMaskImage({ ...bounds, width: 0 }, 0, 600, [surface])).toBeNull();
});
