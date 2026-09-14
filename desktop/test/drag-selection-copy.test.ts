import {afterEach, describe, expect, test} from 'bun:test';
import {
    installDragSelectionCopy,
    type SelectionCopySnapshot,
} from '../frontend/src/shared/dragSelectionCopy';

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

async function settleCopy() {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

function createFixture(writeText?: (text: string) => Promise<void>) {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    Object.defineProperty(documentTarget, 'defaultView', {value: windowTarget});
    const node = {};
    let selection: SelectionCopySnapshot | null = null;
    const copied: string[] = [];
    const errors: unknown[] = [];
    const dispose = installDragSelectionCopy(documentTarget as Document, {
        readSelection: () => selection,
        writeText: writeText ?? (async (text: string) => { copied.push(text); }),
        onError: (error: unknown) => { errors.push(error); },
    });
    cleanups.push(dispose);

    function pointer(type: string, overrides: Partial<PointerEvent> = {}) {
        const event = new Event(type);
        Object.assign(event, {
            pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0,
            buttons: type === 'pointerup' ? 0 : 1, clientX: 0, clientY: 0,
            ...overrides,
        });
        documentTarget.dispatchEvent(event);
    }

    function select(text: string, ranges = '0:6') {
        selection = {text, anchor: node, focus: node, ranges};
        documentTarget.dispatchEvent(new Event('selectionchange'));
    }

    function drag(text = 'selected') {
        pointer('pointerdown');
        pointer('pointermove', {clientX: 10});
        select(text);
        pointer('pointerup', {clientX: 10});
    }

    return {documentTarget, windowTarget, pointer, select, drag, copied, errors, dispose};
}

describe('drag selection copy', () => {
    test('copies on release after a primary mouse drag and preserves whitespace', async () => {
        const fixture = createFixture();
        fixture.pointer('pointerdown');
        fixture.pointer('pointermove', {clientX: 3});
        fixture.select('  selected\ntext\t');
        await settleCopy();
        expect(fixture.copied).toEqual([]);

        fixture.pointer('pointerup', {clientX: 3});
        await settleCopy();
        expect(fixture.copied).toEqual(['  selected\ntext\t']);
    });

    test('ignores clicks, tiny movement, non-primary pointers, touch and right clicks', async () => {
        for (const overrides of [
            {clientX: 0},
            {clientX: 2},
            {clientX: 10, isPrimary: false},
            {clientX: 10, pointerType: 'touch'},
            {clientX: 10, button: 2},
        ]) {
            const fixture = createFixture();
            fixture.pointer('pointerdown', {...overrides, clientX: 0});
            fixture.pointer('pointermove', overrides);
            fixture.select('selected');
            fixture.pointer('pointerup', overrides);
            await settleCopy();
            expect(fixture.copied).toEqual([]);
        }
    });

    test('ignores absent, empty and unchanged selections', async () => {
        const absent = createFixture();
        absent.pointer('pointerdown');
        absent.pointer('pointermove', {clientX: 10});
        absent.pointer('pointerup', {clientX: 10});
        await settleCopy();
        expect(absent.copied).toEqual([]);

        const empty = createFixture();
        empty.drag('');
        await settleCopy();
        expect(empty.copied).toEqual([]);

        const unchanged = createFixture();
        unchanged.select('selected');
        unchanged.drag();
        await settleCopy();
        expect(unchanged.copied).toEqual([]);
    });

    test('copies reselected text when selection changes during the drag then returns', async () => {
        const fixture = createFixture();
        fixture.select('selected');
        fixture.pointer('pointerdown');
        fixture.select('', '0:0');
        fixture.pointer('pointermove', {clientX: 10});
        fixture.select('selected');
        fixture.pointer('pointerup', {clientX: 10});
        await settleCopy();
        expect(fixture.copied).toEqual(['selected']);
    });

    test('copies identical text selected at a different range', async () => {
        const fixture = createFixture();
        fixture.select('selected', '0:8');
        fixture.pointer('pointerdown');
        fixture.pointer('pointermove', {clientX: 10});
        fixture.select('selected', '10:18');
        fixture.pointer('pointerup', {clientX: 10});
        await settleCopy();
        expect(fixture.copied).toEqual(['selected']);
    });

    test('cancels copy for native drag, pointer cancellation or focus loss', async () => {
        for (const cancellation of ['dragstart', 'pointercancel', 'blur']) {
            const fixture = createFixture();
            fixture.pointer('pointerdown');
            fixture.pointer('pointermove', {clientX: 10});
            fixture.select('cancelled');
            if (cancellation === 'blur') {
                fixture.windowTarget.dispatchEvent(new Event('blur'));
            } else {
                fixture.pointer(cancellation);
            }
            fixture.pointer('pointerup', {clientX: 10});
            await settleCopy();
            expect(fixture.copied).toEqual([]);
            fixture.drag('next selection');
            await settleCopy();
            expect(fixture.copied).toEqual(['next selection']);
        }
    });

    test('another pointer cannot complete or move the active gesture', async () => {
        const fixture = createFixture();
        fixture.pointer('pointerdown');
        fixture.pointer('pointermove', {pointerId: 2, clientX: 10});
        fixture.select('selected');
        fixture.pointer('pointerup', {pointerId: 2, clientX: 10});
        await settleCopy();
        expect(fixture.copied).toEqual([]);
        fixture.pointer('pointerup');
        await settleCopy();
        expect(fixture.copied).toEqual([]);
    });

    test('uninstall cancels the pending gesture and removes copy listeners', async () => {
        const fixture = createFixture();
        fixture.pointer('pointerdown');
        fixture.pointer('pointermove', {clientX: 10});
        fixture.select('selected');
        fixture.dispose();
        fixture.pointer('pointerup', {clientX: 10});
        fixture.drag('later');
        await settleCopy();
        expect(fixture.copied).toEqual([]);
    });

    test('reports clipboard rejection without an unhandled rejection', async () => {
        const clipboard = createDeferred<void>();
        const fixture = createFixture(() => clipboard.promise);
        const failure = new Error('clipboard unavailable');
        fixture.drag();
        clipboard.reject(failure);
        await settleCopy();
        expect(fixture.errors).toEqual([failure]);
    });

    test('serializes clipboard writes and discards queued writes after uninstall', async () => {
        const first = createDeferred<void>();
        const second = createDeferred<void>();
        const writes: string[] = [];
        const fixture = createFixture((text: string) => {
            writes.push(text);
            return writes.length === 1 ? first.promise : second.promise;
        });
        fixture.drag('first');
        fixture.drag('second');
        await settleCopy();
        expect(writes).toEqual(['first']);

        first.resolve();
        await settleCopy();
        expect(writes).toEqual(['first', 'second']);

        fixture.drag('third');
        fixture.dispose();
        second.resolve();
        await settleCopy();
        expect(writes).toEqual(['first', 'second']);
    });
});
