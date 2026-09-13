import { expect, mock, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatConfigurationMenuContent } = await import('../frontend/src/features/chat/ChatConfigurationMenu');

type MenuController = ComponentProps<typeof ChatConfigurationMenuContent>['controller'];

function controller(overrides: Partial<MenuController> = {}): MenuController {
  return {
    chatConfiguration: {
      model: 'test-model', modelDisplayName: 'Test model', reasoningEffort: 'high',
      supportedReasoningEfforts: [{ effort: 'high', description: 'High reasoning' }],
      serviceTier: null, serviceTierDisplayName: 'Standard', fastModeAvailable: false, fastModeEnabled: false,
    },
    configurationError: null, configurationLoading: false, configurationMenuOpen: true,
    configurationMenuPosition: { bottom: 40, left: 40, width: 224, submenuSide: 'left' },
    configurationMenuRef: { current: null }, configurationMenuView: 'root', configurationMenuId: 'test-menu',
    fastTier: null,
    models: [{
      id: 'test-model', model: 'test-model', displayName: 'Test model', description: 'A test model',
      isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [],
      serviceTiers: [], defaultServiceTier: null,
    }],
    selectComposerModel: async () => {}, selectComposerReasoningEffort: async () => {},
    selectComposerServiceTier: async () => {}, setConfigurationMenuView: () => {},
    ...overrides,
  };
}

function render(overrides: Partial<MenuController> = {}): string {
  return renderToStaticMarkup(<ChatConfigurationMenuContent controller={controller(overrides)} />);
}

test('saving keeps configuration values and existing menu rows while reporting progress inline', () => {
  const ready = render();
  const saving = render({ configurationLoading: true });
  expect((ready.match(/role="menuitem"/g) ?? []).length).toBe(3);
  expect((saving.match(/role="menuitem"/g) ?? []).length).toBe(3);
  expect(saving).toContain('aria-label="Saving configuration"');
  expect(saving).toContain('data-saving="true"');
  expect(saving).not.toContain('Loading configuration…');
  for (const value of ['Test model', 'High', 'Standard']) expect(saving).toContain(value);
  expect((saving.match(/disabled=""/g) ?? []).length).toBe(3);
  expect(ready).not.toContain('Saving configuration');
});

test('saving preserves selected model and reasoning options while preventing repeated selections', () => {
  for (const configurationMenuView of ['models', 'reasoning'] as const) {
    const html = render({ configurationMenuView, configurationLoading: true });
    expect(html).toMatch(/<button[^>]*aria-selected="true"[^>]*disabled=""[^>]*role="option"/);
    expect(html).toContain('aria-busy="true"');
  }
});

test('unavailable Fast remains disabled independently of saving', () => {
  for (const configurationLoading of [false, true]) {
    const html = render({ configurationMenuView: 'service-tier', configurationLoading });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*data-unavailable="true"[^>]*disabled=""[^>]*role="option"/);
    expect(html).toContain('Unavailable for this model');
  }
});

test('initial loading and save failures retain their distinct status messages', () => {
  const initial = render({ chatConfiguration: null, models: [], configurationLoading: true });
  expect(initial).toContain('Loading configuration…');
  expect(initial).not.toContain('Saving configuration');
  const failed = render({ configurationError: 'Could not save model' });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('Could not save model');
  expect(failed).not.toContain('Saving configuration');
});
