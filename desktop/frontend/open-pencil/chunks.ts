/** Keep libraries reusable across views without pulling lazy exporters into startup. */
export function libraryChunk(id: string): string | undefined {
  if (id.includes('commonjsHelpers.js') || id.includes('vite/preload-helper')) return 'vendor-runtime';
  const file = id.replaceAll('\\', '/');
  const dependency = file.split('/node_modules/').at(-1);
  if (dependency === file) return undefined;
  if (/^(?:react|react-dom|scheduler)\//.test(dependency!)) return 'vendor-react';
  if (/^(?:vue|@vue)\//.test(dependency!)) return 'vendor-vue';
  if (/^@codemirror\//.test(dependency!)) return 'vendor-codemirror';
  if (/^@lezer\/(?:common|lr|highlight)\//.test(dependency!)) return 'vendor-grammar-runtime';
  const grammar = dependency!.match(/^@lezer\/([^/]+)\//)?.[1];
  if (grammar) return `vendor-grammar-${grammar}`;
  if (/^(?:yjs|lib0|y-protocols|y-indexeddb)\//.test(dependency!)) return 'vendor-collaboration';
  if (/^(?:opentype\.js|@xmldom\/xmldom|acorn|@sveltejs\/acorn-typescript)\//.test(dependency!)) return 'vendor-parsers';
  if (/^@tauri-apps\//.test(dependency!)) return 'vendor-tauri';
  // Controls, streamed markup and their compiler share initialization helpers;
  // keep this dependency family together to avoid circular chunk evaluation.
  if (/^(?:reka-ui|@floating-ui|@vueuse|motion-v|motion-dom|motion-utils|@tanstack|tailwind-variants|tailwind-merge|parse5|css-tree|markdown-exit|@stream-markdown|@markmend|vue-stream-markdown|twirlwind|esrap|js-yaml|sucrase|valibot|unifont)\//.test(dependency!)) return 'vendor-ui';
  if (/^(?:canvaskit-wasm|yoga-layout)\//.test(dependency!)) return 'vendor-graphics';
  return undefined;
}

export function viewerChunk(id: string): string | undefined {
  const library = libraryChunk(id);
  if (library) return library;
  if (id.includes('/desktop/shared/') || id.includes('/experiments/codex-specialists/src/')
    || /\/desktop\/frontend\/src\/(?:product|cheshiDesktop|workspaceManager)\.ts$/.test(id)) return 'shared-contracts';
  // Pane contexts and resume state are shared contracts, even though their
  // source lives beside AppShell. Keep consumers from importing the shell back.
  if (/\/features\/shell\/(?:WorkspaceLayoutControls(?:\.module)?|workspaceLayoutModel|updateWorkspaceResume)\./.test(id)
    || id.endsWith('/features/scheduler/useScheduler.ts')) return 'shared-ui';
  if (id.endsWith('/features/scheduler/useSchedulerSessionSync.ts')) return 'feature-chat';
  const feature = id.match(/\/desktop\/frontend\/src\/features\/([^/]+)\//)?.[1];
  if (feature === 'agents' || feature === 'agent-chats') return 'feature-homies';
  if (feature === 'calendar' || feature === 'scheduler') return 'feature-calendar';
  if (feature) return `feature-${feature}`;
  if (id.includes('/desktop/frontend/src/shared/')) return 'shared-ui';
  return undefined;
}
