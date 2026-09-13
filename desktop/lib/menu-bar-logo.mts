import { fileURLToPath } from 'node:url';
import type { nativeImage } from 'electron';

export interface MenuBarLogo { width: number; height: number; alpha: Uint8Array }

/** Reuse the packaged brand artwork as a tintable menu-bar alpha mask. */
export function loadMenuBarLogo(images: Pick<typeof nativeImage, 'createFromPath'>): MenuBarLogo {
  const image = images.createFromPath(fileURLToPath(new URL('../../resources/icons/startup-logo.png', import.meta.url)));
  if (image.isEmpty()) throw new Error('The Cheshi menu-bar logo could not be loaded.');
  const resized = image.resize({ width: 88, quality: 'best' });
  const { width, height } = resized.getSize();
  const bitmap = resized.toBitmap();
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index++) alpha[index] = bitmap[index * 4 + 3]!;
  return { width, height, alpha };
}
