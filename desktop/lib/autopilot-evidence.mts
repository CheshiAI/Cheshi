import type { AutopilotPage } from './autopilot-model.mts';

/** Candidates are bounded verbatim passages; the model returns an ID, never invented prose. */
export function researchPassages(text: string): Record<string, string> {
  const passages = [...new Set(text.split(/\n+/).map(line => line.trim()).filter(line => line.length >= 40))]
    .slice(0, 100).map(line => line.slice(0, 1200));
  return Object.fromEntries(passages.map((passage, index) => [`passage_${index}`, passage]));
}

/** Search snippets help navigation but are not evidence from the original source. */
export function researchPagePassages(page: Pick<AutopilotPage, 'url' | 'text'>): Record<string, string> {
  const url = new URL(page.url);
  const google = /(^|\.)google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(url.hostname);
  if (google && (url.pathname === '/search' || url.pathname === '/webhp' || url.pathname === '/')
    && (url.pathname === '/search' || url.searchParams.has('q'))) return {};
  return researchPassages(page.text);
}
