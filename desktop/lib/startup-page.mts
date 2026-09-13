import { readFileSync } from 'node:fs';

const logoDataUrl = `data:image/png;base64,${readFileSync(new URL('../../resources/icons/startup-logo.png', import.meta.url)).toString('base64')}`;
const themeTokens = readFileSync(new URL('../frontend/src/shared/styles/tokens.css', import.meta.url), 'utf8');

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export function startupPage(name: string, version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(name)}</title>
  <style>
    ${themeTokens}
    :root {
      color-scheme: dark;
      --space-default: 16px;
      --text: #e6eef2;
      --startup-logo: url('${logoDataUrl}');
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      background: #101419;
      color: var(--text);
      font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
      user-select: none;
      -webkit-app-region: drag;
      isolation: isolate;
    }
    .atmosphere {
      position: absolute;
      z-index: -2;
      inset: -25%;
      background:
        radial-gradient(ellipse at 30% 24%, #32577366, transparent 48%),
        radial-gradient(ellipse at 76% 55%, #2a656b38, transparent 46%),
        radial-gradient(ellipse at 55% 82%, #3b3b6630, transparent 48%);
      animation: atmosphere-drift 14s ease-in-out infinite alternate;
    }
    .grid {
      position: absolute;
      z-index: -1;
      inset: 0;
      background-image: radial-gradient(#aac9dd22 .7px, transparent .7px);
      background-size: 24px 24px;
      mask-image: radial-gradient(ellipse at 50% 40%, black, transparent 68%);
    }
    main {
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: var(--space-default);
      padding: 36px var(--space-default) 30px;
    }
    .scene { position: relative; width: 168px; height: 137px; flex-shrink: 0; perspective: 700px; }
    .aura {
      position: absolute;
      inset: 11px 4px 19px;
      border-radius: 50%;
      background: radial-gradient(ellipse, #93dce329, #5e93c412 45%, transparent 70%);
      animation: aura-breathe 6s ease-in-out infinite;
    }
    .logo-arrival {
      position: absolute;
      width: 124px;
      height: 121px;
      left: 22px;
      top: 4px;
      animation: arrive 850ms cubic-bezier(.16, 1, .3, 1) both;
    }
    .logo-float {
      width: 100%;
      height: 100%;
      transform-style: preserve-3d;
      animation: logo-float 6s ease-in-out infinite;
    }
    .logo-art {
      position: absolute;
      inset: 0;
      background: var(--startup-logo) center / contain no-repeat;
      filter: drop-shadow(0 12px 14px #0007) drop-shadow(0 0 1px #c9f8ff35);
    }
    .logo-sheen {
      position: absolute;
      inset: 0;
      mask: var(--startup-logo) center / contain no-repeat;
      background: linear-gradient(115deg, transparent 36%, #c2edff22 43%, #ffffffa8 49%, #b2f5ff38 54%, transparent 62%);
      background-size: 300% 100%;
      mix-blend-mode: screen;
      animation: sheen 5s ease-in-out infinite;
    }
    .shadow {
      position: absolute;
      bottom: 0;
      left: 46.5px;
      width: 75px;
      height: 8px;
      border-radius: 50%;
      background: #02090eb3;
      filter: blur(6px);
      animation: shadow-breathe 6s ease-in-out infinite;
    }
    .spark {
      position: absolute;
      width: 2px;
      height: 2px;
      border-radius: 50%;
      background: #c5eaff;
      box-shadow: 0 0 7px #84ceff;
      opacity: 0;
      animation: spark-rise 2.2s ease-in-out infinite;
    }
    .spark:nth-child(1) { left: 4px; top: 99px; animation-delay: -.1s; }
    .spark:nth-child(2) { right: 5px; top: 76px; animation-delay: -.47s; }
    .spark:nth-child(3) { left: 17px; top: 46px; animation-delay: -.83s; }
    .spark:nth-child(4) { right: 19px; top: 127px; animation-delay: -1.2s; }
    .spark:nth-child(5) { left: 13px; top: 131px; animation-delay: -1.57s; }
    .spark:nth-child(6) { right: 9px; top: 39px; animation-delay: -1.93s; }
    .identity { display: flex; flex-direction: column; align-items: center; max-width: 100%; gap: 12px; }
    h1 {
      color: var(--title);
      margin: 0 -.28em 0 0;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: .28em;
      text-transform: uppercase;
    }
    .status-row { display: flex; align-items: center; gap: 8px; min-height: 18px; color: var(--sidebar-section-label-color); }
    #status { margin: 0; line-height: 18px; text-align: center; }
    .activity { display: flex; flex-shrink: 0; align-items: center; gap: 2px; height: 10px; }
    .activity i { width: 2px; height: 8px; border-radius: 2px; background: currentColor; animation: activity 1s ease-in-out infinite; }
    .activity i:nth-child(2) { animation-delay: -.65s; }
    .activity i:nth-child(3) { animation-delay: -.35s; }
    .track { width: 135px; height: 2px; background: #b1d0e016; overflow: hidden; border-radius: 2px; }
    .track::after {
      content: ''; display: block; width: 55%; height: 100%;
      background: linear-gradient(90deg, transparent, #aedfe7, transparent);
      animation: travel 2s cubic-bezier(.45, 0, .55, 1) infinite;
    }
    .version { position: absolute; bottom: 12px; left: 0; right: 0; margin: 0; text-align: center; color: var(--sub-text); font-size: 10px; letter-spacing: .06em; }
    @keyframes arrive { from { opacity: 0; transform: translateY(18px) scale(.9); } to { opacity: 1; transform: none; } }
    @keyframes logo-float {
      0%, 100% { transform: translateY(4px) rotateX(3deg) rotateY(-9deg) rotateZ(-3deg); }
      50% { transform: translateY(-9px) rotateX(-5deg) rotateY(9deg) rotateZ(3deg); }
    }
    @keyframes sheen { 0%, 15% { background-position: 150% 0; } 65%, 100% { background-position: -50% 0; } }
    @keyframes atmosphere-drift { from { transform: translate(-3%, -2%) rotate(-6deg); } to { transform: translate(3%, 3%) rotate(6deg); } }
    @keyframes aura-breathe { 0%, 100% { opacity: .65; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.12); } }
    @keyframes shadow-breathe { 0%, 100% { opacity: .65; transform: scaleX(1); } 50% { opacity: .35; transform: scaleX(.76); } }
    @keyframes spark-rise { 0%, 100% { opacity: 0; transform: translateY(6px); } 35% { opacity: .8; } 80% { opacity: 0; transform: translateY(-30px); } }
    @keyframes activity { 0%, 100% { transform: scaleY(.4); opacity: .45; } 50% { transform: scaleY(1); opacity: 1; } }
    @keyframes travel { from { transform: translateX(-110%); } to { transform: translateX(290%); } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; }
      .track::after { transform: translateX(40%); }
    }
  </style>
</head>
<body>
  <div class="atmosphere" aria-hidden="true"></div>
  <div class="grid" aria-hidden="true"></div>
  <main aria-busy="true">
    <div class="scene" role="img" aria-label="${escapeHtml(name)} logo">
      <div class="aura"></div>
      <div class="logo-arrival"><div class="logo-float"><div class="logo-art"></div><div class="logo-sheen"></div></div></div>
      <div class="shadow"></div>
      <div aria-hidden="true"><i class="spark"></i><i class="spark"></i><i class="spark"></i><i class="spark"></i><i class="spark"></i><i class="spark"></i></div>
    </div>
    <div class="identity">
      <h1>${escapeHtml(name)}</h1>
      <div class="status-row">
        <span class="activity" aria-hidden="true"><i></i><i></i><i></i></span>
        <p id="status" role="status" aria-live="polite">Starting ${escapeHtml(name)}…</p>
      </div>
      <div class="track" aria-hidden="true"></div>
    </div>
  </main>
  <p class="version">${escapeHtml(version)}</p>
</body>
</html>`;
}
