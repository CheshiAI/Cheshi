import type { AutopilotPage } from './autopilot-model.mts';

/** Candidates are bounded verbatim passages; the model returns an ID, never invented prose. */
export function researchPassages(text: string): Record<string, string> {
  const passages: string[] = [];
  let pending = '';
  const add = () => { if (pending.trim()) passages.push(pending.trim()); pending = ''; };
  for (let line of text.split(/\n+/).map(line => line.trim()).filter(Boolean)) {
    if (pending && (pending.length >= 40 || pending.length + line.length + 1 > 1200)) add();
    // Neighboring short fields retain their context instead of being dropped.
    while (line.length > 1200) {
      add(); passages.push(line.slice(0, 1200)); line = line.slice(1100);
    }
    pending += (pending ? '\n' : '') + line;
  }
  add();
  return Object.fromEntries([...new Set(passages)].slice(0, 100).map((passage, index) => [`passage_${index}`, passage]));
}

export function isResearchSearchPage(value: string): boolean {
  const url = new URL(value);
  const google = /(^|\.)google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(url.hostname);
  return google && (url.pathname === '/search' || url.pathname === '/webhp' || url.pathname === '/')
    && (url.pathname === '/search' || url.searchParams.has('q'));
}

/** Search snippets help navigation but are not evidence from the original source. */
export function researchPagePassages(page: Pick<AutopilotPage, 'url' | 'text' | 'section'>): Record<string, string> {
  if (isResearchSearchPage(page.url)) return {};
  if (page.section?.kind === 'code' || page.section?.kind === 'table') {
    const passages: string[] = [];
    for (let offset = 0; offset < page.text.length; offset += 1100) {
      const passage = page.text.slice(offset, offset + 1200).trim();
      if (passage) passages.push(passage);
      if (offset + 1200 >= page.text.length) break;
    }
    return Object.fromEntries(passages.slice(0, 100).map((passage, index) => [`passage_${index}`, passage]));
  }
  return researchPassages(page.text);
}
