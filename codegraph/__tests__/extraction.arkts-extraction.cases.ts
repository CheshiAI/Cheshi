import { extractFromSource } from '../src/extraction';
import { getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerArktsExtractionTests(): void {


  // =============================================================================
  // ArkTS (HarmonyOS / OpenHarmony declarative UI — `.ets`)
  // =============================================================================

  describe('ArkTS Extraction', () => {
    it('reports ArkTS as supported', () => {
      expect(isLanguageSupported('arkts')).toBe(true);
      expect(getSupportedLanguages()).toContain('arkts');
    });

    describe('@Component struct extraction', () => {
      const code = `
import { TodoItem } from '../model/TodoItem';

@Entry
@Component
struct Index {
  @State message: string = 'Hello';
  @Prop count: number = 0;
  @StorageLink('theme') theme: string = 'light';
  private service: TodoService = new TodoService();

  aboutToAppear(): void {
    this.load();
  }

  load(): void {
    this.message = 'loaded';
  }

  build() {
    Column() {
      Text(this.message).fontSize(50)
    }
    .height('100%')
  }
}
`;

      it('extracts the struct with its ArkUI decorators', () => {
        const result = extractFromSource('pages/Index.ets', code);
        const comp = result.nodes.find((n) => n.kind === 'struct' && n.name === 'Index');
        expect(comp).toBeDefined();
        expect(comp?.language).toBe('arkts');
        expect(comp?.decorators).toEqual(expect.arrayContaining(['Entry', 'Component']));
      });

      it('extracts an EXPORTED struct whose decorators sit on the export statement', () => {
        const result = extractFromSource(
          'components/Card.ets',
          `@Component\nexport struct Card {\n  build() {\n    Row() {}\n  }\n}\n`
        );
        const card = result.nodes.find((n) => n.kind === 'struct' && n.name === 'Card');
        expect(card).toBeDefined();
        expect(card?.isExported).toBe(true);
        expect(card?.decorators).toContain('Component');
      });

      it('extracts struct members: build(), lifecycle + regular methods with qualified names', () => {
        const result = extractFromSource('pages/Index.ets', code);
        const methods = result.nodes.filter((n) => n.kind === 'method');
        expect(methods.find((m) => m.qualifiedName === 'Index::build')).toBeDefined();
        expect(methods.find((m) => m.qualifiedName === 'Index::aboutToAppear')).toBeDefined();
        expect(methods.find((m) => m.qualifiedName === 'Index::load')).toBeDefined();
      });

      it('extracts @State/@Prop/@StorageLink members as properties with their decorators', () => {
        const result = extractFromSource('pages/Index.ets', code);
        const message = result.nodes.find((n) => n.kind === 'property' && n.qualifiedName === 'Index::message');
        expect(message).toBeDefined();
        expect(message?.decorators).toContain('State');
        const count = result.nodes.find((n) => n.kind === 'property' && n.qualifiedName === 'Index::count');
        expect(count?.decorators).toContain('Prop');
        // Decorator-with-args: the decorator NAME is captured, not its argument.
        const theme = result.nodes.find((n) => n.kind === 'property' && n.qualifiedName === 'Index::theme');
        expect(theme?.decorators).toContain('StorageLink');
      });

      it('emits intra-struct method call refs (this.load())', () => {
        const result = extractFromSource('pages/Index.ets', code);
        const call = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'load'
        );
        expect(call).toBeDefined();
      });
    });

    describe('build() DSL call surface', () => {
      const code = `
@Extend(Text) function titleStyle(size: number) {
  .fontSize(size)
}

@Component
struct Page {
  count: number = 0;

  handleTap(): void {
    this.count += 1;
  }

  @Builder
  headerBar(title: string) {
    Row() {
      Text(title).titleStyle(24)
      Button('Go').onClick(this.handleTap)
    }
  }

  build() {
    Column({ space: 8 }) {
      this.headerBar('Home')
      ChildCard({ label: 'hi' })
    }
    .height('100%')
  }
}
`;

      function callRefsFrom(result: ReturnType<typeof extractFromSource>, methodName: string): string[] {
        const from = result.nodes.find((n) => n.kind === 'method' && n.name === methodName);
        return result.unresolvedReferences
          .filter((r) => r.referenceKind === 'calls' && r.fromNodeId === from?.id)
          .map((r) => r.referenceName);
      }

      it('emits a call ref for a custom component instantiation inside build()', () => {
        const result = extractFromSource('pages/Page.ets', code);
        expect(callRefsFrom(result, 'build')).toContain('ChildCard');
      });

      it('emits dot-prefixed call refs for chained attributes (@Extend/@Styles-only resolution)', () => {
        const result = extractFromSource('pages/Page.ets', code);
        // `.titleStyle(24)` chains on the Text component — one node, repeated
        // property/arguments field pairs, NOT nested call_expressions. The
        // leading dot routes the ref to the decorator-gated matcher strategy so
        // framework attributes (`.height` below) can never hit an arbitrary
        // same-named symbol.
        expect(callRefsFrom(result, 'headerBar')).toContain('.titleStyle');
        expect(callRefsFrom(result, 'build')).toContain('.height');
        expect(callRefsFrom(result, 'build')).not.toContain('height');
      });

      it('recovers the detached-chain shape (chain on the line after a nested component)', () => {
        // Inside arkui_children, a chain starting after the closing `}` is
        // detached by the grammar into sibling leading_dot_expression +
        // parenthesized_expression statements — the close-button idiom.
        const detached = `
@Component
struct Panel {
  close(): void {}

  build() {
    Column() {
      Row() {
        Text('x')
      }
      .width(10)
      .onClick(this.close)
      .id('close_button')
    }
  }
}
`;
        const result = extractFromSource('components/Panel.ets', detached);
        const refs = callRefsFrom(result, 'build');
        expect(refs).toContain('close');
        expect(refs).toContain('.width');
        expect(refs).not.toContain('width');
      });

      it('dot-prefixes the innermost call of a proper-form detached chain', () => {
        // `.alignItems(x).layoutWeight(1)` under a leading_dot_expression: the
        // wrapper consumes the dot, so the innermost call has a bare identifier
        // function and would otherwise emit as a plain `alignItems(...)` call.
        const chained = `
@Component
struct Card {
  build() {
    Column() {
      List() {
        Text('x')
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .height('100%')
    }
  }
}
`;
        const result = extractFromSource('components/Card.ets', chained);
        const refs = callRefsFrom(result, 'build');
        expect(refs).toContain('.alignItems');
        expect(refs).not.toContain('alignItems');
        expect(refs).toContain('.layoutWeight');
        expect(refs).not.toContain('layoutWeight');
      });

      it('emits a call ref for an .onClick(this.handler) method-reference binding', () => {
        const result = extractFromSource('pages/Page.ets', code);
        expect(callRefsFrom(result, 'headerBar')).toContain('handleTap');
      });

      it('emits a call ref for a @Builder method invoked as this.headerBar()', () => {
        const result = extractFromSource('pages/Page.ets', code);
        expect(callRefsFrom(result, 'build')).toContain('headerBar');
      });

      it('extracts a global @Extend function with its decorator', () => {
        const result = extractFromSource('pages/Page.ets', code);
        const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'titleStyle');
        expect(fn).toBeDefined();
        expect(fn?.decorators).toContain('Extend');
      });
    });

    describe('Global @Builder functions', () => {
      it('extracts a decorated global @Builder function with signature and decorator', () => {
        const result = extractFromSource(
          'common/builders.ets',
          `@Builder\nfunction EmptyHint(message: string) {\n  Column() {\n    Text(message).fontSize(16)\n  }\n}\n`
        );
        const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'EmptyHint');
        expect(fn).toBeDefined();
        expect(fn?.signature).toBe('(message: string)');
        expect(fn?.decorators).toContain('Builder');
      });
    });

    describe('Standard TypeScript constructs in .ets', () => {
      it('extracts classes, interfaces, enums, type aliases and their members', () => {
        const code = `
export enum Priority { Low, Medium = 2, High }

export interface Shape {
  area(): number;
}

export type Handler = (e: string) => void;

export class Service {
  private count: number = 0;
  doWork(x: number): number {
    return this.helper(x);
  }
  helper(n: number): number { return n * 2; }
}
`;
        const result = extractFromSource('common/service.ets', code);
        expect(result.nodes.find((n) => n.kind === 'class' && n.name === 'Service')).toBeDefined();
        expect(result.nodes.find((n) => n.kind === 'enum' && n.name === 'Priority')).toBeDefined();
        const members = result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.qualifiedName);
        expect(members).toEqual(expect.arrayContaining(['Priority::Low', 'Priority::Medium', 'Priority::High']));
        expect(result.nodes.find((n) => n.kind === 'interface' && n.name === 'Shape')).toBeDefined();
        expect(result.nodes.find((n) => n.kind === 'type_alias' && n.name === 'Handler')).toBeDefined();
        const doWork = result.nodes.find((n) => n.qualifiedName === 'Service::doWork');
        expect(doWork?.kind).toBe('method');
        expect(doWork?.signature).toBe('(x: number): number');
        expect(
          result.unresolvedReferences.find((r) => r.referenceKind === 'calls' && r.referenceName === 'helper')
        ).toBeDefined();
      });
    });

    describe('Import extraction', () => {
      it('extracts relative, SDK (@ohos/@kit) and default imports', () => {
        const code = `
import router from '@ohos.router';
import { promptAction } from '@kit.ArkUI';
import { TodoItem } from '../model/TodoItem';
import DataStore from '../data/DataStore';
`;
        const result = extractFromSource('pages/imports.ets', code);
        const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
        expect(imports).toContain('@ohos.router');
        expect(imports).toContain('@kit.ArkUI');
        expect(imports).toContain('../model/TodoItem');
        expect(imports).toContain('../data/DataStore');
      });
    });
  });
}
