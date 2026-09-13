export interface GithubDraftLink {
  href: string;
  label: string;
}

function trimLinkPunctuation(value: string): string {
  let result = value.replace(/[.,!?;:。]+$/u, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (result.endsWith(close) && result.split(close).length > result.split(open).length) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

/** Detect links locally; previews never fetch remote content or alter the draft. */
export function githubDraftLinks(draft: string): GithubDraftLink[] {
  const candidates = draft.match(/https?:\/\/[^\s<>"'`]+|(?<![\w@./:-])(?:www\.)?github\.com[^\s<>"'`]*/giu) ?? [];
  const links = new Map<string, GithubDraftLink>();
  for (const candidate of candidates) {
    const text = trimLinkPunctuation(candidate);
    let url: URL;
    try { url = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`); }
    catch { continue; }
    if (!['github.com', 'www.github.com'].includes(url.hostname)
      || url.username || url.password || url.port) continue;
    url.hostname = 'github.com';
    const href = url.href;
    if (links.has(href)) continue;
    const path = url.pathname.replace(/^\//u, '');
    links.set(href, { href, label: path ? `${path}${url.search}${url.hash}` : `GitHub${url.search}${url.hash}` });
  }
  return [...links.values()];
}
