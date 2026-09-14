import {afterEach, describe, expect, test} from 'bun:test';
import {installFileSearchShortcut} from '../frontend/src/shared/fileSearchShortcut';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function createFixture(handled = true) {
    const target = new EventTarget();
    let triggers = 0;
    const dispose = installFileSearchShortcut(target as Window, () => { triggers++; return handled; });
    cleanups.push(dispose);
    const keyboard = (overrides: Partial<KeyboardEvent> = {}) => {
        const event = Object.assign(new Event('keydown', {cancelable: true}), {
            key: 'F', code: 'KeyF', shiftKey: true, repeat: false, isComposing: false,
            ctrlKey: false, metaKey: false, altKey: false, ...overrides,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
    };
    return {target, keyboard, dispose, triggers: () => triggers};
}

describe('Shift + F file search shortcut', () => {
    test('opens immediately on keydown and consumes only handled shortcuts', () => {
        const fixture = createFixture();
        expect(fixture.keyboard()).toBe(true);
        expect(fixture.triggers()).toBe(1);
        const blocked = createFixture(false);
        expect(blocked.keyboard()).toBe(false);
        expect(blocked.triggers()).toBe(1);
    });

    test('uses the physical F key across layouts, with a fallback when code is unavailable', () => {
        const fixture = createFixture();
        for (const flags of [{key: 'ㄹ'}, {key: 'f', code: ''}, {key: 'F', code: ''}]) {
            expect(fixture.keyboard(flags)).toBe(true);
        }
        expect(fixture.triggers()).toBe(3);
    });

    test('ignores plain F, other keys, extra modifiers, repeats and IME input', () => {
        const fixture = createFixture();
        for (const flags of [
            {shiftKey: false}, {key: 'G', code: 'KeyG'}, {key: 'Shift', code: 'ShiftLeft'},
            {ctrlKey: true}, {metaKey: true}, {altKey: true}, {repeat: true},
            {isComposing: true}, {keyCode: 229},
        ]) expect(fixture.keyboard(flags)).toBe(false);
        expect(fixture.triggers()).toBe(0);
    });

    test('composition lifecycle blocks unmarked events and blur resets composition', () => {
        const fixture = createFixture();
        fixture.target.dispatchEvent(new Event('compositionstart'));
        expect(fixture.keyboard()).toBe(false);
        fixture.target.dispatchEvent(new Event('compositionend'));
        expect(fixture.keyboard()).toBe(true);
        fixture.target.dispatchEvent(new Event('compositionstart'));
        fixture.target.dispatchEvent(new Event('blur'));
        expect(fixture.keyboard()).toBe(true);
        expect(fixture.triggers()).toBe(2);
    });

    test('cleanup removes the shortcut listener', () => {
        const fixture = createFixture();
        fixture.dispose();
        expect(fixture.keyboard()).toBe(false);
        expect(fixture.triggers()).toBe(0);
    });
});
