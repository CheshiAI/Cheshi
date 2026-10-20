import type { Plugin } from 'vite';

const rulerSize = 16;
const rulerFontSize = 9;
const badgeHeight = 10;
const textBaseline = (rulerSize / 2 + rulerFontSize * 0.3) / rulerSize;

function replaceRequired(source: string, from: string, to: string, count = 1): string {
  const parts = source.split(from);
  if (parts.length !== count + 1) {
    throw new Error(`OpenPencil ruler integration needs review: expected ${count} occurrences of ${from}`);
  }
  return parts.join(to);
}

/** SDK 0.16 inlines ruler dimensions into several published modules. Keep
 * drawing, guide hit testing and overlay insets in agreement without editing
 * dependency files. Fail explicitly if an SDK update changes these boundaries. */
export function transformOpenPencilRulers(source: string, id: string): string | null {
  const filename = id.split('?')[0]!.replaceAll('\\', '/');
  const marker = '/@open-pencil/core/dist/';
  const position = filename.lastIndexOf(marker);
  if (position < 0) return null;
  const module = filename.slice(position + marker.length);
  if (module === 'constants.js') {
    let result = replaceRequired(source, 'const RULER_SIZE = 20;', `const RULER_SIZE = ${rulerSize};`);
    result = replaceRequired(result, 'const RULER_BADGE_HEIGHT = 14;', `const RULER_BADGE_HEIGHT = ${badgeHeight};`);
    return replaceRequired(result, 'const RULER_TEXT_BASELINE = .65;', `const RULER_TEXT_BASELINE = ${textBaseline};`);
  }
  if (module === 'canvas/rulers.js') {
    let result = replaceRequired(source, 'const R = 20;', `const R = ${rulerSize};`, 4);
    // The SDK shares this font with measurement labels. Restore it after drawing.
    result = replaceRequired(result, 'if (!font) return;', `if (!font) return;
    const previousFontSize = font.getSize();
    font.setSize(${rulerFontSize});
    try {`);
    result = replaceRequired(result, 'drawGuideRulerPositions(r, canvas, graph, font, guides);',
      'drawGuideRulerPositions(r, canvas, graph, font, guides);\n    } finally { font.setSize(previousFontSize); }');
    result = replaceRequired(result, '20 * RULER_TEXT_BASELINE', `${rulerSize} * RULER_TEXT_BASELINE`, 2);
    result = replaceRequired(result, '0, 3, r.rulerTextPaint, font)', `0, ${rulerFontSize * 0.3}, r.rulerTextPaint, font)`);
    result = replaceRequired(result, '2, 3, r.auxFill, font)', `2, ${rulerFontSize * 0.3}, r.auxFill, font)`);
    result = replaceRequired(result, 'const h = 14;', `const h = ${badgeHeight};`);
    const badgeTop = (rulerSize - badgeHeight) / 2;
    result = replaceRequired(result, 'r.ck.LTRBRect(bx, 3, bx + textW + 6, 17)',
      `r.ck.LTRBRect(bx, ${badgeTop}, bx + textW + 6, ${badgeTop + badgeHeight})`);
    result = replaceRequired(result, 'canvas.translate(10, by + bw / 2)',
      `canvas.translate(${rulerSize / 2}, by + bw / 2)`);
    return replaceRequired(result, 'r.ck.LTRBRect(-bw / 2, -7, bw / 2, h / 2)',
      `r.ck.LTRBRect(-bw / 2, ${-badgeHeight / 2}, bw / 2, h / 2)`);
  }
  if (module === 'canvas/renderer/overlay-pass.js') {
    return replaceRequired(source, 'const inset = r.showRulers ? 20 : 0;',
      `const inset = r.showRulers ? ${rulerSize} : 0;`);
  }
  if (module === 'profiler/hud-renderer.js') {
    return replaceRequired(source, 'const RULER_SIZE = 20;', `const RULER_SIZE = ${rulerSize};`);
  }
  return null;
}

export function openPencilRulers(): Plugin {
  return {
    name: 'cheshi-open-pencil-rulers',
    enforce: 'pre',
    transform(source, id) {
      const code = transformOpenPencilRulers(source, id);
      return code === null ? null : { code, map: null };
    },
  };
}
