/** Parse Markdown file targets without accepting URL schemes or network paths. */
export function localFileLinkPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 16_384) return null;
  const target = value.replace(/(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*(?:C[1-9]\d*)?)$/, '');
  if (/[?#]/u.test(target)) return null;
  let path: string;
  try { path = decodeURIComponent(target); }
  catch { return null; }
  if (!path || path !== path.trim() || /[\u0000-\u001f\u007f\\]/u.test(path)
    || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(path)) return null;
  return path;
}

export function localPathHref(path: string): string {
  return path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

/** Explicit Markdown preserves spaces and punctuation in a dropped folder path. */
export function localPathMarkdown(path: string): string {
  const href = localPathHref(path);
  if (!path.startsWith('/') || localFileLinkPath(href) !== path) throw new TypeError('Invalid local path.');
  return `[${path.replace(/[\\[\]`*_]/g, '\\$&')}](<${href}>)`;
}
