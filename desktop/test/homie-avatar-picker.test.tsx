import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { AgentAvatarPicker } from '../frontend/src/features/agents/AgentAvatarPicker';
import type { AgentAvatarValue } from '../shared/agent-avatar';
import { avatarFile, avatarPng } from './agent-avatar-image-fixtures';
import { withDOM } from './agent-chats-test-dom';

const initial: AgentAvatarValue = { character: 'sprout', color: 'mint' };
async function upload(file: File) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Agent icon image"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
}

test('image selection previews locally, waits for decoding, applies explicitly and can return to a catalog icon', async () => {
  const changes: AgentAvatarValue[] = [];
  function Editor() {
    const [avatar, setAvatar] = useState(initial);
    return <AgentAvatarPicker value={avatar} disabled={false} onChange={value => { changes.push(value); setAvatar(value); }} />;
  }
  await withDOM(async ui => {
    const images: HTMLImageElement[] = [], OriginalImage = window.Image;
    window.Image = class extends OriginalImage { constructor() { super(); Object.defineProperty(this, 'src', { configurable: true, writable: true, value: '' }); images.push(this); } };
    try {
      await ui.render(<Editor />); await ui.click('Choose agent icon');
      expect(document.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('.png,.jpg,.gif,.webp');
      await upload(avatarFile());
      expect(images).toHaveLength(1);
      await ui.click('Save'); expect(changes).toHaveLength(0);
      Object.defineProperties(images[0]!, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
      await act(async () => images[0]!.dispatchEvent(new window.Event('load')));
      expect(document.querySelector('dialog img')?.getAttribute('src')).toBe(avatarPng);
      expect(changes).toHaveLength(0);
      await ui.click('Save'); expect(changes[0]?.image).toBe(avatarPng);
      expect(document.querySelector('[aria-label="Choose agent icon"] img')?.getAttribute('src')).toBe(avatarPng);
      await ui.click('Choose agent icon'); await ui.click('Character crab'); await ui.click('Save');
      expect(changes.at(-1)).toEqual({ character: 'crab', color: 'mint' });
      expect(document.querySelectorAll('[aria-label="Choose agent icon"] img')).toHaveLength(0);
    } finally { window.Image = OriginalImage; }
  });
});

test('canceling or closing ignores a late image decode and rejected uploads preserve the original icon', async () => {
  const changes: AgentAvatarValue[] = [];
  await withDOM(async ui => {
    const images: HTMLImageElement[] = [], OriginalImage = window.Image;
    window.Image = class extends OriginalImage { constructor() { super(); Object.defineProperty(this, 'src', { configurable: true, writable: true, value: '' }); images.push(this); } };
    try {
      await ui.render(<AgentAvatarPicker value={initial} disabled={false} onChange={value => changes.push(value)} />);
      await ui.click('Choose agent icon');
      await upload(avatarFile(avatarPng, 'icon.svg'));
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Choose');
      expect(images).toHaveLength(0);
      await upload(avatarFile()); await ui.click('Cancel'); await ui.click('Choose agent icon');
      Object.defineProperties(images[0]!, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
      await act(async () => images[0]!.dispatchEvent(new window.Event('load')));
      expect(document.querySelectorAll('dialog img')).toHaveLength(0);
      await upload(avatarFile());
      await act(async () => images[1]!.dispatchEvent(new window.Event('error')));
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('decode');
      await ui.click('Save'); expect(changes).toEqual([initial]);
    } finally { window.Image = OriginalImage; }
  });
});
