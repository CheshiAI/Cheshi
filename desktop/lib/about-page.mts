import { readFileSync } from 'node:fs';

const logo = `data:image/png;base64,${readFileSync(new URL('../../resources/icons/about-logo.png', import.meta.url)).toString('base64')}`;
const themeTokens = readFileSync(new URL('../frontend/src/shared/styles/tokens.css', import.meta.url), 'utf8');
function appBackgroundColor(): string {
  const color = themeTokens.match(/--app-bg:\s*(#[\da-f]{6})\s*;/iu)?.[1];
  if (!color) throw new Error('The About window requires the --app-bg theme token.');
  return color;
}
export const aboutBackgroundColor = appBackgroundColor();

interface AboutMetadata {
  name: string;
  version: string;
  buildNumber: string;
  publisher: string;
  year?: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export function aboutPage(metadata: AboutMetadata): string {
  const name = escapeHtml(metadata.name);
  const buildNumber = /^\d+$/u.test(metadata.buildNumber) ? metadata.buildNumber.padStart(4, '0') : metadata.buildNumber;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>About ${name}</title>
  <style>
    ${themeTokens}
    :root { color-scheme: dark; --space-default: 16px; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      background: var(--app-bg); color: #dedede;
      font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-app-region: drag; user-select: none;
    }
    main { height: 100%; display: flex; flex-direction: column; align-items: center; padding: 48px 24px 24px; }
    .logo { display: block; width: 160px; height: 160px; object-fit: contain; }
    h1 { font-size: 28px; line-height: 1.2; font-weight: 700; margin: 24px 0 var(--space-default); }
    dl { display: grid; grid-template-columns: auto auto; gap: 8px var(--space-default); margin: 0; line-height: 1.5; }
    dt { text-align: right; font-weight: 600; }
    dd { margin: 0; color: #a0a1a3; font-variant-numeric: tabular-nums; }
    footer { margin-top: auto; padding-top: var(--space-default); color: #84868a; text-align: center; }
  </style>
</head>
<body>
  <main>
    <img class="logo" src="${logo}" alt="${name}" draggable="false">
    <h1>${name}</h1>
    <dl aria-label="Application information">
      <dt>Version</dt><dd>${escapeHtml(metadata.version)}</dd>
      <dt>Build</dt><dd>${escapeHtml(buildNumber)}</dd>
    </dl>
    <footer>© ${metadata.year ?? new Date().getFullYear()} ${escapeHtml(metadata.publisher)}</footer>
  </main>
</body>
</html>`;
}
