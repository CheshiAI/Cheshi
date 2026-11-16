import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { ChatCommandMenu } from '../frontend/src/features/chat/ChatCommandMenu';
import { handleChatComposerKey, nextChatCommandIndex } from '../frontend/src/features/chat/chatComposerKeyboard';
import { slashCommands } from '../frontend/src/features/chat/chatViewModel';
import type { ChatViewController } from '../frontend/src/features/chat/useChatViewController';
import { withDOM } from './agent-chats-test-dom';

test('arrow keys mark real shared buttons active, skip disabled entries, and work with menu focus', async () => {
  await withDOM(async ui => {
    const choices = slashCommands.filter(command => ['new', 'fork', 'status'].includes(command.name));
    const selected: string[] = [];
    function Fixture() {
      const [index, setIndex] = useState(0);
      const [open, setOpen] = useState(true);
      const handleKeyDown: ChatViewController['handleKeyDown'] = event => handleChatComposerKey(event, {
        locked: false, menuOpen: open, goalOpen: false, pickerOpen: true,
        closeMenu: () => setOpen(false), saveGoal() {},
        moveOption: offset => setIndex(current => nextChatCommandIndex(current, offset, [true, false, true])),
        activateOption: () => selected.push(choices[index]!.name), enqueue: () => false, submit() {},
      });
      const controller = { commandMenuOpen: open, commandMenuMode: 'commands', slashMenuOpen: true,
        commandMenuTitle: 'Commands', commandMenuHelp: 'Navigate', commandMenuId: 'commands',
        filteredCommands: choices, highlightedIndex: index, setHighlightedIndex: setIndex,
        commandDisabledReason: (command: typeof choices[number]) => command.name === 'fork' ? 'Busy' : null,
        activateSlashCommand: (command: typeof choices[number]) => selected.push(command.name),
        closeCommandMenu: () => setOpen(false), handleKeyDown,
      } as unknown as ChatViewController;
      return <><textarea aria-label="Composer" onKeyDown={handleKeyDown} /><ChatCommandMenu controller={controller} /></>;
    }
    await ui.render(<Fixture />);
    const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const key = async (target: Element, value: string) => act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    });
    expect(options()[0]?.dataset.active).toBe('true');
    await key(document.querySelector('textarea')!, 'ArrowDown');
    expect(options().map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(options()[2]?.dataset.active).toBe('true');
    expect(options()[0]?.dataset.active).toBeUndefined();
    await act(async () => options()[2]!.focus());
    await key(options()[2]!, 'ArrowDown');
    expect(options()[0]?.dataset.active).toBe('true');
    await key(options()[2]!, 'Enter');
    expect(selected).toEqual(['new']);
    await key(options()[2]!, 'ArrowUp');
    expect(options()[2]?.dataset.active).toBe('true');
    await key(options()[2]!, 'Escape');
    expect(options()).toEqual([]);
  });
});

test('command navigation handles empty and fully disabled lists without looping', () => {
  expect(nextChatCommandIndex(0, 1, [])).toBe(0);
  expect(nextChatCommandIndex(1, -1, [false, false])).toBe(1);
});
