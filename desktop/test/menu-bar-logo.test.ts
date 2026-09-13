import { expect, test } from 'bun:test';
import type { NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { loadMenuBarLogo } from '../lib/menu-bar-logo.mts';

test('loads packaged logo artwork and extracts only alpha from the resized native bitmap', () => {
  let path = '';
  let resizeOptions: unknown;
  const bitmap = Buffer.from([20, 40, 60, 255, 80, 90, 100, 0]);
  const image = {
    isEmpty: () => false,
    resize(options: unknown) {
      resizeOptions = options;
      return { getSize: () => ({ width: 2, height: 1 }), toBitmap: () => bitmap };
    },
  } as unknown as NativeImage;
  const logo = loadMenuBarLogo({ createFromPath(value) { path = value; return image; } });
  expect(path.endsWith('/resources/icons/startup-logo.png')).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(resizeOptions).toEqual({ width: 88, quality: 'best' });
  expect(logo).toEqual({ width: 2, height: 1, alpha: new Uint8Array([255, 0]) });
  bitmap[3] = 0;
  expect(logo.alpha[0]).toBe(255);
});

test('reports missing logo artwork before attempting to rasterize it', () => {
  const image = { isEmpty: () => true } as NativeImage;
  expect(() => loadMenuBarLogo({ createFromPath: () => image })).toThrow('could not be loaded');
});
