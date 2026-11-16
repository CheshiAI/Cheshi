export const avatarPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
export const avatarGif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
export function avatarFile(source = avatarPng, name = 'icon.png') {
  const [header, content] = source.split(',');
  return new File([Uint8Array.from(atob(content!), c => c.charCodeAt(0))], name, { type: header!.slice(5, -7) });
}
