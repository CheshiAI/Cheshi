import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NeumorphicTextField } from '../frontend/src/shared/ui/NeumorphicTextField';

test('clear action empties a controlled input, restores focus and respects field restrictions', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let clears = 0;
  let submits = 0;
  let setValue!: (value: string) => void;
  let setRestriction!: (value: 'editable' | 'disabled' | 'readonly') => void;
  let setCustomAction!: (value: boolean) => void;
  function Fixture() {
    const [value, updateValue] = useState('A long note title');
    const [restriction, updateRestriction] = useState<'editable' | 'disabled' | 'readonly'>('editable');
    const [customAction, updateCustomAction] = useState(false);
    setValue = updateValue;
    setRestriction = updateRestriction;
    setCustomAction = updateCustomAction;
    return <form onSubmit={event => { event.preventDefault(); submits++; }}>
      <label>Title
        <NeumorphicTextField variant="standard" value={value} onChange={event => updateValue(event.target.value)}
          disabled={restriction === 'disabled'} readOnly={restriction === 'readonly'}
          onClear={() => { clears++; updateValue(''); }} clearLabel="Clear title"
          trailingAction={customAction ? <button type="button">Custom action</button> : undefined} />
      </label>
      <NeumorphicTextField aria-label="Unchanged field" value="Keep this" onChange={() => {}} />
    </form>;
  }
  const clearButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Clear title"]');
  try {
    await act(async () => root.render(<Fixture />));
    const input = container.querySelector('input')!;
    expect(clearButton()?.title).toBe('Clear title');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => { clearButton()!.focus(); clearButton()!.click(); });
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(clearButton()).toBeNull();
    expect(clears).toBe(1);
    expect(submits).toBe(0);
    await act(async () => { setValue('New title'); });
    expect(clearButton()).not.toBeNull();
    for (const restriction of ['disabled', 'readonly'] as const) {
      await act(async () => { setRestriction(restriction); });
      expect(clearButton()?.disabled).toBe(true);
      await act(async () => { clearButton()!.click(); });
      expect(input.value).toBe('New title');
      expect(clears).toBe(1);
    }
    await act(async () => { setRestriction('editable'); setCustomAction(true); });
    expect(clearButton()).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Custom action');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Unchanged field"]')?.value).toBe('Keep this');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
