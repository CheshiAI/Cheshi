import { describe, expect, test } from 'bun:test';

import {
  canInstallPlugin,
  canUninstallPlugin,
  featuredPlugins,
  filterPlugins,
  installedPlugins,
  pluginBrandColor,
  pluginInitial,
  pluginUninstallId,
} from '../frontend/src/features/plugins/model.ts';
import type { CodexPluginSummary } from '../frontend/src/cheshiDesktop.ts';

function plugin(id: string, overrides: Partial<CodexPluginSummary> = {}): CodexPluginSummary {
  const name = id.split('@')[0] ?? id;
  return {
    id,
    name,
    displayName: name,
    shortDescription: '',
    longDescription: '',
    developerName: 'OpenAI',
    category: 'Tools',
    capabilities: [],
    keywords: [],
    defaultPrompts: [],
    brandColor: null,
    hasLogo: false,
    installed: false,
    enabled: true,
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
    availability: 'AVAILABLE',
    disabledReason: null,
    source: 'remote',
    version: null,
    localVersion: null,
    marketplaceName: 'remote',
    marketplaceDisplayName: 'Remote',
    reference: { pluginName: name, remoteMarketplaceName: 'remote' },
    ...overrides,
  };
}

describe('plugin directory model', () => {
  test('filters across plugin metadata and preserves featured order', () => {
    const github = plugin('github@remote', {
      displayName: 'GitHub',
      shortDescription: 'Triage pull requests.',
      capabilities: ['Code review'],
    });
    const slack = plugin('slack@remote', {
      displayName: 'Slack',
      keywords: ['messages', 'team chat'],
    });
    const catalog = {
      plugins: [github, slack],
      featuredPluginIds: ['slack@remote', 'missing@remote', 'github@remote'],
      marketplaceErrors: [],
    };

    expect(filterPlugins(catalog.plugins, 'code review')).toEqual([github]);
    expect(filterPlugins(catalog.plugins, 'TEAM messages')).toEqual([slack]);
    expect(featuredPlugins(catalog)).toEqual([slack, github]);
  });

  test('sorts installed plugins and derives safe presentation values', () => {
    const zeta = plugin('zeta@remote', { installed: true, brandColor: '#12abef' });
    const alpha = plugin('alpha@remote', { installed: true, installPolicy: 'INSTALLED_BY_DEFAULT' });
    const unavailable = plugin('locked@remote', { availability: 'DISABLED_BY_ADMIN' });

    expect(installedPlugins([zeta, unavailable, alpha])).toEqual([alpha, zeta]);
    expect(pluginInitial(zeta)).toBe('Z');
    expect(pluginBrandColor(zeta)).toBe('#12abef');
    expect(pluginBrandColor(plugin('unsafe@remote', { brandColor: 'url(javascript:bad)' }))).toMatch(/^#[\da-f]{6}$/i);
    expect(canInstallPlugin(unavailable)).toBe(false);
    expect(canUninstallPlugin(alpha)).toBe(false);
    expect(canUninstallPlugin(zeta)).toBe(true);
  });

  test('uses backend ids to uninstall remote plugins and config ids for local plugins', () => {
    const remote = plugin('context7@remote', {
      reference: { pluginName: 'plugin_context7_remote', remoteMarketplaceName: 'remote' },
    });
    const local = plugin('workflow@local', {
      source: 'local',
      reference: { pluginName: 'workflow', marketplacePath: '/plugins/marketplace.json' },
    });

    expect(pluginUninstallId(remote)).toBe('plugin_context7_remote');
    expect(pluginUninstallId(local)).toBe('workflow@local');
  });
});
