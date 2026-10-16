import { expect, mock, test } from 'bun:test';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
mock.module('../frontend/src/shared/ui/Tooltip.module.css', () => ({
  default: { anchor: 'tooltip-anchor', content: 'tooltip-content' },
}));
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

test('model options reveal the full name and description on hover while retaining selection', async () => {
  const window = new Window();
  const geometry = new Map(['getBoundingClientRect', 'getClientRects'].map(key =>
    [key, Object.getOwnPropertyDescriptor(window.Element.prototype, key)]));
  Object.defineProperties(window.Element.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new window.DOMRect(20, 20, 240, 32) },
    getClientRects: { configurable: true, value: () => [new window.DOMRect(20, 20, 240, 32)] },
  });
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const model = { ...controller().models[0]!, displayName: 'A model with a long display name',
    description: 'The complete model description remains available even when the menu shortens its visible text.' };
  let selected: MenuController['models'][number] | undefined;
  try {
    await act(async () => root.render(<ChatConfigurationMenuContent controller={controller({
      configurationMenuView: 'models', models: [model], selectComposerModel: async value => { selected = value; },
    })} />));
    const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(option.hasAttribute('title')).toBe(false);
    await act(async () => {
      option.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }) as unknown as Event);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe(`${model.displayName}\n${model.description}`);
    expect(option.getAttribute('aria-describedby')).toBe(tooltip!.id);
    expect(container.contains(tooltip)).toBe(false);
    await act(async () => {
      option.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }) as unknown as Event);
      option.click();
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(selected).toBe(model);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of geometry) {
      if (descriptor) Object.defineProperty(window.Element.prototype, key, descriptor);
      else Reflect.deleteProperty(window.Element.prototype, key);
    }
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

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
