import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ForgeConfig } from '@electron-forge/shared-types';
import { macOSSigningOptions } from './config/macos-signing.mts';

const rootDirectory = fileURLToPath(new URL('.', import.meta.url));

function shouldIgnore(packagePath: string): boolean {
  const normalizedPath = packagePath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalizedPath) return false;

  const segments = normalizedPath.split('/');
  const [rootEntry, childEntry, grandchildEntry] = segments;

  if (rootEntry === '.env.product' || rootEntry === 'package.json') return segments.length > 1;
  if (rootEntry === 'config') {
    if (segments.length === 1) return false;
    const packagedConfigFiles = new Set(['product.mts', 'workspace-storage.mts']);
    return childEntry === undefined || !packagedConfigFiles.has(childEntry) || segments.length > 2;
  }
  if (rootEntry === 'resources') {
    if (segments.length === 1) return false;
    if (childEntry !== 'icons') return true;
    const packagedIcons = new Set(['startup-logo.png', 'app-icon.png', 'about-logo.png']);
    return segments.length > 2 && (!grandchildEntry || !packagedIcons.has(grandchildEntry) || segments.length > 3);
  }
  if (rootEntry !== 'desktop') return true;
  if (segments.length === 1) return false;
  if (childEntry === 'bootstrap.mts' || childEntry === 'main.mts' || childEntry === 'workspace-runtime.mts') return segments.length > 2;
  if (childEntry === 'frontend') {
    const startupTokensPath = 'desktop/frontend/src/shared/styles/tokens.css';
    return normalizedPath !== startupTokensPath && !startupTokensPath.startsWith(`${normalizedPath}/`);
  }
  if (childEntry === 'shared') {
    if (segments.length === 2) return false;
    const packagedSharedFiles = new Set(['chat-agent-details.ts', 'chat-async-questions.ts', 'apple-notes.ts', 'apple-notes-document.ts', 'keep-awake.ts', 'app-update.ts', 'codex-accounts.ts', 'codex-account-usage.ts', 'showcase.ts', 'chat-attachment-import.ts', 'chat-history-search.ts', 'chat-mcp-status.ts', 'github-issues.ts', 'editor-session.ts', 'chat-question-dismissals.ts', 'chat-relay.ts', 'chat-saved-turns.ts', 'chat-saved-turn-continuation.ts', 'chat-user-input.ts', 'ephemeral-session.ts', 'temporary-chat.ts', 'git-discard.ts', 'local-history.ts', 'plugin-actions.ts', 'workspace-code-explanation.ts', 'workspace-management.ts', 'workspace-disk-usage.ts', 'workspace-file-search.ts']);
    return grandchildEntry === undefined || !packagedSharedFiles.has(grandchildEntry) || segments.length > 3;
  }
  if (childEntry !== 'lib') return true;
  if (segments.length === 2) return false;
  if (grandchildEntry === 'electron-libghostty') return false;
  const packagedLibraryFiles = new Set([
    'codex-agent-token-usage.mts',
    'codex-chat-agent-details.mts',
    'apple-notes-service.mts',
    'apple-notes-cache.mts',
    'apple-notes-script.mts',
    'apple-notes-process.mts',
    'apple-notes-ipc.mts',
    'selection-copy.mts',
    'about-page.mts',
    'about-window.mts',
    'about-menu.mts',
    'workspace-codegraph-mcp.mts',
    'workspace-chat-instructions.mts',
    'app-release-checker.mts',
    'app-update-service.mts',
    'keep-awake-service.mts',
    'app-update-preview.mts',
    'app-update-resume.mts',
    'app-update-download.mts',
    'app-update-installer.mts',
    'local-history-store.mts',
    'local-history-service.mts',
    'local-history-ipc.mts',
    'local-history-runtime.mts',
    'development-shutdown.mts',
    'chat-attachment-store.mts',
    'chat-attachment-transfer.mts',
    'chat-history-compiler.mts',
    'chat-history-index-store.mts',
    'chat-history-search.mts',
    'editor-session.mts',
    'editor-session-ipc.mts',
    'workspace-session-stores.mts',
    'chat-question-dismissals.mts',
    'chat-question-dismissals-ipc.mts',
    'codex-chat-turn-controls.mts',
    'codegraph-service.mts',
    'codegraph-initial-index.mts',
    'account-usage-tray.mts',
    'account-usage-background.mts',
    'account-usage-tray-icon.mts',
    'menu-bar-font.mts',
    'menu-bar-logo.mts',
    'showcase-browser.mts',
    'showcase-page-theme.mts',
    'codex-account-service.mts',
    'codex-account-clients.mts',
    'codex-account-availability.mts',
    'codex-conversation-catalog.mts',
    'codex-conversation-agents.mts',
    'codex-chat-account-continuity.mts',
    'codex-account-profiles.mts',
    'codex-account-profiles-session.mts',
    'codex-account-profiles-store.mts',
    'codex-accounts-ipc.mts',
    'workspace-codex-accounts.mts',
    'codex-app-server-client.mts',
    'codex-app-server-shutdown.mts',
    'codex-mcp-probe.mts',
    'codex-chat-catalog-operations.mts',
    'codex-chat-catalog.mts',
    'codex-chat-configuration.mts',
    'codex-chat-contexts.mts',
    'codex-chat-ipc.mts',
    'codex-chat-relay.mts',
    'codex-chat-relay-turn.mts',
    'codex-chat-relay-workflow.mts',
    'codex-chat-relay-history.mts',
    'codex-chat-saved-turns.mts',
    'codex-chat-events.mts',
    'codex-chat-permissions.mts',
    'codex-chat-plugins.mts',
    'codex-chat-service.mts',
    'codex-chat-stop.mts',
    'codex-chat-session-deletion.mts',
    'codex-chat-thread-data.mts',
    'codex-chat-thread-operations.mts',
    'codex-chat-types.mts',
    'codex-chat-user-input.mts',
    'codex-chat-user-input-schema.mts',
    'codex-chat-values.mts',
    'codex-service-utils.mts',
    'ephemeral-session-service.mts',
    'temporary-chat-service.mts',
    'temporary-chat-ipc.mts',
    'ghostty-surface-host.mts',
    'git-command.mts',
    'git-discard.mts',
    'git-ipc.mts',
    'git-parsers.mts',
    'git-service.mts',
    'git-types.mts',
    'github-issue-service.mts',
    'github-pull-request-data.mts',
    'github-pull-request-diff.mts',
    'github-pull-request-merge-state.mts',
    'github-pull-request-queries.mts',
    'github-pull-request-service.mts',
    'json-rpc-client-utils.mts',
    'language-server-client.mts',
    'language-server-command.mts',
    'language-server-documents.mts',
    'language-server-ipc.mts',
    'language-server-manager.mts',
    'language-server-results.mts',
    'language-server-runtime.mts',
    'language-server-settings.mts',
    'language-server-types.mts',
    'plugin-logo-service.mts',
    'skill-recording-store.mts',
    'startup-page.mts',
    'startup-screen.mts',
    'terminal-controller.mts',
    'workspace-code-explanation.mts',
    'workspace-disk-usage.mts',
    'workspace-file-entries.mts',
    'workspace-file-ipc.mts',
    'workspace-file-metadata.mts',
    'workspace-file-paths.mts',
    'workspace-file-reads.mts',
    'workspace-file-service.mts',
    'workspace-file-search.mts',
    'workspace-file-types.mts',
    'workspace-file-watch.mts',
    'workspace-file-writes.mts',
    'workspace-management-ipc.mts',
    'workspace-management-service.mts',
    'workspace-deletion.mts',
    'github-repositories.mts',
    'github-login-service.mts',
    'workspace-manager-window.mts',
    'workspace-manager-runtime.mts',
    'workspace-tool-status.mts',
    'workspace-codex-login.mts',
    'workspace-startup.mts',
    'workspace-application.mts',
    'workspace-ipc-router.mts',
    'workspace-renderer-events.mts',
    'workspace-window-readiness.mts',
  ]);
  return grandchildEntry === undefined || !packagedLibraryFiles.has(grandchildEntry) || segments.length > 3;
}

export default async function createForgeConfiguration(): Promise<ForgeConfig> {
  const { product } = await import('./config/product.mts');

  return {
    hooks: {
      readPackageJson: async (_forgeConfig, packageJson) => ({ ...packageJson, version: product.version }),
    },
    packagerConfig: {
      ...macOSSigningOptions(process.env, process.platform),
      name: product.displayName,
      icon: path.join(rootDirectory, 'resources', 'icons', 'app-icon.icns'),
      appBundleId: product.bundleId,
      appVersion: product.version,
      buildVersion: product.buildNumber,
      extendInfo: {
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        NSAppleEventsUsageDescription: 'Cheshi reads the Apple Notes you select and saves responses as new notes when you ask.',
      },
      asar: {
        unpack: '**/desktop/lib/electron-libghostty/native/**',
      },
      ignore: shouldIgnore,
      extraResource: [
        path.join(rootDirectory, 'desktop', 'runtime'),
        path.join(rootDirectory, 'desktop', 'frontend', 'dist'),
        path.join(rootDirectory, 'desktop', 'native', 'electron-libghostty', 'LICENSE.electron-libghostty'),
        path.join(rootDirectory, 'desktop', 'native', 'ghostty-bridge', 'LICENSE.libghostty-spm'),
        path.join(rootDirectory, 'desktop', 'native', 'ghostty-bridge', 'LICENSE.msdisplaylink'),
      ],
    },
    makers: [
      {
        name: '@electron-forge/maker-zip',
        config: {},
      },
    ],
  };
}
