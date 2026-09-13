import { expect, test } from 'bun:test';
import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemporaryChatConfigurationMenuContent, temporaryConfigurationPosition } from '../frontend/src/features/chat/TemporaryChatConfigurationMenu';

type Props = ComponentProps<typeof TemporaryChatConfigurationMenuContent>;
const model: Props['models'][number] = {
  id: 'model-a', model: 'provider-a', displayName: 'Model A', description: 'Provider model description',
  isDefault: true, defaultReasoningEffort: 'medium', serviceTiers: [], defaultServiceTier: null,
  supportedReasoningEfforts: [{ effort: 'medium', description: 'Balanced reasoning' }, { effort: 'high', description: 'More reasoning' }],
};
function props(overrides: Partial<Props> = {}): Props {
  return {
    id: 'temporary-menu', menuRef: { current: null },
    models: [model], model: model.model, effort: 'medium', disabled: false, view: 'root',
    position: temporaryConfigurationPosition({ top: 500, right: 900 }, { width: 1000, height: 700 }),
    onModelChange() {}, onEffortChange() {}, onViewChange() {}, ...overrides,
  };
}
function buttons(node: ReactNode): ComponentProps<'button'>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [...(node.type === 'button' ? [node.props as ComponentProps<'button'>] : []), ...buttons(node.props.children)];
}

test('temporary menu routes model and reasoning selections using their original values', () => {
  for (const view of ['models', 'reasoning'] as const) {
    const changes: string[] = [];
    const views: string[] = [];
    const tree = TemporaryChatConfigurationMenuContent(props({ view,
      onModelChange(value) { changes.push(value); }, onEffortChange(value) { changes.push(value); },
      onViewChange(value) { views.push(value); },
    }));
    const option = buttons(tree).find(button => button.role === 'option');
    expect(option?.['aria-selected']).toBe(true);
    (option?.onClick as (() => void))();
    expect(changes).toEqual([view === 'models' ? 'provider-a' : 'medium']);
    expect(views).toEqual(['root']);
    expect(renderToStaticMarkup(tree)).toContain(view === 'models' ? model.description : 'Balanced reasoning');
  }
});

test('temporary menu exposes only supported settings and disables choices when busy', () => {
  const html = renderToStaticMarkup(TemporaryChatConfigurationMenuContent(props()));
  expect((html.match(/role="menuitem"/g) ?? []).length).toBe(2);
  expect(html).not.toContain('Service tier');
  const tree = TemporaryChatConfigurationMenuContent(props({ disabled: true, view: 'models' }));
  expect(buttons(tree).every(button => button.disabled)).toBe(true);
});

test('position follows the trigger, chooses an available side, and stacks inside narrow windows', () => {
  const right = temporaryConfigurationPosition({ top: 500, right: 900 }, { width: 1000, height: 700 });
  expect(right.submenuSide).toBe('left');
  expect(right.left + right.width).toBe(900);
  expect(right.bottom).toBe(208);
  expect(right.stacked).toBe(false);
  const left = temporaryConfigurationPosition({ top: 500, right: 240 }, { width: 1000, height: 700 });
  expect(left.submenuSide).toBe('right');
  const narrow = temporaryConfigurationPosition({ top: 400, right: 290 }, { width: 300, height: 600 });
  expect(narrow.stacked).toBe(true);
  expect(narrow.left).toBeGreaterThanOrEqual(8);
  expect(narrow.left + narrow.width).toBeLessThanOrEqual(292);
  expect(narrow.submenuHeight + narrow.bottom + 94).toBeLessThanOrEqual(592);
});
