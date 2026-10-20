import { expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { Layers, SlidersHorizontal } from 'lucide-react';
import { CanvasSidePanel } from '../frontend/src/features/canvas/integration/sdk/CanvasSidePanel';
import { withDOM } from './agent-chats-test-dom';

function toggle(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
function panel(label: string) {
  return document.getElementById(toggle(label).getAttribute('aria-controls')!)!;
}

function Fixture({ layers = <input aria-label="Layer draft" defaultValue="Layer" />, properties = <input aria-label="Property draft" defaultValue="Property" /> }: {
  layers?: ReactNode; properties?: ReactNode;
}) {
  return <CanvasSidePanel panels={[
    { id: 'layers', label: 'Pages and layers', icon: Layers, children: layers },
    { id: 'properties', label: 'Design properties', icon: SlidersHorizontal, children: properties },
  ]} />;
}

test('one canvas rail switches panels, closes the selected panel and preserves mounted drafts', async () => {
  await withDOM(async ui => {
    await ui.render(<Fixture />);
    const layers = panel('Pages and layers'), properties = panel('Design properties');
    expect(document.querySelectorAll('[role="group"][aria-label="Canvas panel controls"]').length).toBe(1);
    expect(layers.hasAttribute('inert')).toBe(true);
    expect(properties.hasAttribute('inert')).toBe(true);
    expect(layers.id).not.toBe(properties.id);
    await ui.click('Pages and layers');
    expect(toggle('Pages and layers').getAttribute('aria-expanded')).toBe('true');
    expect(layers.hasAttribute('inert')).toBe(false);
    expect(properties.hidden).toBe(true);
    const draft = layers.querySelector<HTMLInputElement>('input')!;
    await ui.type('Layer draft', 'Unsaved layer name');
    await ui.click('Design properties');
    expect(layers.hidden).toBe(true);
    expect(layers.hasAttribute('inert')).toBe(true);
    expect(toggle('Pages and layers').getAttribute('aria-expanded')).toBe('false');
    expect(properties.hasAttribute('inert')).toBe(false);
    expect(properties.hidden).toBe(false);
    await ui.click('Pages and layers');
    expect(layers.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('Unsaved layer name');
    await ui.click('Pages and layers');
    expect(toggle('Pages and layers').getAttribute('aria-expanded')).toBe('false');
    expect(layers.hasAttribute('inert')).toBe(true);
    expect(properties.hasAttribute('inert')).toBe(true);
  });
});

test('Escape commits focused property input on blur and returns focus to its rail', async () => {
  await withDOM(async ui => {
    let committed = '';
    await ui.render(<Fixture properties={<input aria-label="Property draft" defaultValue="Before" onBlur={event => { committed = event.currentTarget.value; }} />} />);
    await ui.click('Design properties');
    const input = panel('Design properties').querySelector<HTMLInputElement>('input')!;
    await act(async () => { input.focus(); });
    await ui.type('Property draft', 'After');
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(committed).toBe('After');
    expect(toggle('Design properties').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle('Design properties'));
    expect(panel('Design properties').hasAttribute('inert')).toBe(true);
  });
});

test('Escape consumed by a child leaves its canvas panel open', async () => {
  await withDOM(async ui => {
    await ui.render(<Fixture layers={<input aria-label="Child editor" onKeyDown={event => { if (event.key === 'Escape') event.preventDefault(); }} />} />);
    await ui.click('Pages and layers');
    const input = panel('Pages and layers').querySelector('input')!;
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(toggle('Pages and layers').getAttribute('aria-expanded')).toBe('true');
  });
});

test('switching away from properties commits its focused input before hiding it', async () => {
  await withDOM(async ui => {
    let committed = '';
    let hiddenAtCommit = true;
    await ui.render(<Fixture properties={<input aria-label="Property draft" defaultValue="Before" onBlur={event => {
      committed = event.currentTarget.value;
      hiddenAtCommit = panel('Design properties').hidden;
    }} />} />);
    await ui.click('Design properties');
    await act(async () => { panel('Design properties').querySelector('input')!.focus(); });
    await ui.type('Property draft', 'After');
    await ui.click('Pages and layers');
    expect(committed).toBe('After');
    expect(hiddenAtCommit).toBe(false);
    expect(panel('Design properties').hidden).toBe(true);
    expect(toggle('Pages and layers').getAttribute('aria-expanded')).toBe('true');
  });
});

test('Escape from the rail closes the selected panel and focuses its button', async () => {
  await withDOM(async ui => {
    await ui.render(<Fixture />);
    await ui.click('Design properties');
    await act(async () => {
      toggle('Design properties').focus();
      toggle('Design properties').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(panel('Design properties').hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(toggle('Design properties'));
  });
});
