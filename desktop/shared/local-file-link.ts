/** Parse Markdown file targets without accepting URL schemes or network paths. */
export function localFileLinkPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 16_384) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { return null; }
  const path = decoded.replace(/(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*(?:C[1-9]\d*)?)$/, '');
  if (!path || path !== path.trim() || /[\u0000-\u001f\u007f\\?#]/u.test(path)
    || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(path)) return null;
  return path;
}
