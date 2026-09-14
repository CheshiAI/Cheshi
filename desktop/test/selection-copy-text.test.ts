import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {EditorSelection, EditorState} from '@codemirror/state';
import type {SelectionCopySnapshot} from '../frontend/src/shared/dragSelectionCopy';

// Supply DOM boundaries in an isolated realm, following the renderer's VM tests.
// Editor selections use real CodeMirror state without starting Electron.
class TestElement extends EventTarget {
    parentElement: TestElement | null = null;
    selectors = new Set<string>();
    textContent = '';

    closest(selector: string): TestElement | null {
        const alternatives = selector.split(',').map((value) => value.trim());
        if (alternatives.some((value) => this.selectors.has(value))) return this;
        return this.parentElement?.closest(selector) ?? null;
    }
}

class TestInput extends TestElement {
    type = 'text';
    value = '';
    selectionStart: number | null = null;
    selectionEnd: number | null = null;
}

class TestTextArea extends TestElement {
    value = '';
    selectionStart: number | null = null;
    selectionEnd: number | null = null;
}

interface TestSelection {
    isCollapsed: boolean;
    rangeCount: number;
    anchorNode: object;
    focusNode: object;
    anchorOffset: number;
    focusOffset: number;
    toString(): string;
}

const source = readFileSync(new URL('../frontend/src/shared/selectionCopyText.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023},
}).outputText;

function createFixture() {
    let selection: TestSelection | null = null;
    const views = new Map<TestElement, {state: EditorState}>();
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(compiled, {
        exports,
        Element: TestElement,
        HTMLElement: TestElement,
        HTMLInputElement: TestInput,
        HTMLTextAreaElement: TestTextArea,
        require(name: string) {
            if (name !== '@codemirror/view') throw new Error(`Unexpected dependency: ${name}`);
            return {EditorView: {findFromDOM: (element: TestElement) => views.get(element) ?? null}};
        },
    });
    const read = exports.readSelectionCopyText;
    if (typeof read !== 'function') throw new Error('Missing selection reader');

    return {
        views,
        read(origin: EventTarget | null) {
            return read({getSelection: () => selection}, origin) as SelectionCopySnapshot | null;
        },
        select(text: string) {
            const node = {};
            selection = {
                isCollapsed: text.length === 0, rangeCount: 1,
                anchorNode: node, focusNode: node, anchorOffset: 0, focusOffset: text.length,
                toString: () => text,
            };
            return selection;
        },
    };
}

describe('selection copy text', () => {
    test('reads ordinary document text with original whitespace and selection identity', () => {
        const fixture = createFixture();
        const selection = fixture.select('  message\nsecond line\t');
        const result = fixture.read(new TestElement());
        expect(result?.text).toBe('  message\nsecond line\t');
        expect(result?.anchor).toBe(selection.anchorNode);
        expect(result?.focus).toBe(selection.focusNode);
        expect(result?.ranges).toBe(`0:${selection.focusOffset}`);
    });

    test('returns no text for absent or collapsed document selections', () => {
        const fixture = createFixture();
        expect(fixture.read(null)).toBeNull();
        fixture.select('');
        expect(fixture.read(new TestElement())).toBeNull();
    });

    test('uses selected input and textarea values instead of an unrelated document selection', () => {
        const fixture = createFixture();
        fixture.select('unrelated page selection');
        for (const field of [new TestInput(), new TestTextArea()]) {
            field.value = 'prefix  selected\ntext suffix';
            field.selectionStart = 6;
            field.selectionEnd = 21;
            const result = fixture.read(field);
            expect(result?.text).toBe(field.value.slice(6, 21));
            expect(result?.anchor).toBe(field);
            expect(result?.ranges).toBe('6:21');
            field.selectionEnd = 6;
            expect(fixture.read(field)).toBeNull();
        }
    });

    test('excludes password and unsupported input types without using the page selection', () => {
        const fixture = createFixture();
        fixture.select('unrelated page selection');
        for (const type of ['password', 'number', 'email', 'hidden']) {
            const input = new TestInput();
            input.type = type;
            input.value = 'private value';
            input.selectionStart = 0;
            input.selectionEnd = input.value.length;
            expect(fixture.read(input)).toBeNull();
        }
    });

    test('excludes selections originating inside inert or explicitly excluded containers', () => {
        const fixture = createFixture();
        fixture.select('selected');
        for (const selector of ['[inert]', '[data-selection-copy="off"]']) {
            const parent = new TestElement();
            parent.selectors.add(selector);
            const child = new TestElement();
            child.parentElement = parent;
            expect(fixture.read(child)).toBeNull();
        }
    });

    test('reads all CodeMirror selection ranges from state beyond the visible DOM text', () => {
        const fixture = createFixture();
        const editor = new TestElement();
        editor.selectors.add('.cm-editor');
        editor.textContent = 'line 0';
        const content = new TestElement();
        content.parentElement = editor;
        const doc = Array.from({length: 500}, (_, index) => `line ${index}`).join('\n');
        const state = EditorState.create({
            doc,
            extensions: [EditorState.allowMultipleSelections.of(true)],
            selection: EditorSelection.create([
                EditorSelection.range(0, 20),
                EditorSelection.range(doc.length - 20, doc.length),
            ]),
        });
        const view = {state};
        fixture.views.set(editor, view);
        fixture.select('visible fragment only');
        const result = fixture.read(content);
        expect(result?.text).toBe(`${doc.slice(0, 20)}\n${doc.slice(-20)}`);
        expect(result?.anchor).toBe(view);
        expect(result?.ranges).toBe(`0:20,${doc.length - 20}:${doc.length}`);
    });

    test('does not fall back to stale page text for missing or unselected editor views', () => {
        const fixture = createFixture();
        const editor = new TestElement();
        editor.selectors.add('.cm-editor');
        fixture.select('stale page text');
        expect(fixture.read(editor)).toBeNull();
        fixture.views.set(editor, {state: EditorState.create({doc: 'editor text'})});
        expect(fixture.read(editor)).toBeNull();
    });

    test('reads tooltip selection instead of the underlying editor selection', () => {
        const fixture = createFixture();
        const editor = new TestElement();
        editor.selectors.add('.cm-editor');
        fixture.views.set(editor, {
            state: EditorState.create({doc: 'code', selection: EditorSelection.range(0, 4)}),
        });
        const tooltip = new TestElement();
        tooltip.selectors.add('.cm-tooltip');
        tooltip.parentElement = editor;
        const text = new TestElement();
        text.parentElement = tooltip;
        fixture.select('Cannot find name');
        expect(fixture.read(text)?.text).toBe('Cannot find name');
    });
});
