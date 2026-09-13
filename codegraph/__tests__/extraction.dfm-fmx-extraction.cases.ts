import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerDfmFmxExtractionTests(): void {


  // =============================================================================
  // DFM/FMX Extraction
  // =============================================================================

  describe('DFM/FMX Extraction', () => {
    it('should extract components from DFM', () => {
      const code = `object Form1: TForm1
  Left = 0
  Top = 0
  Caption = 'My Form'
  object Button1: TButton
    Left = 10
    Top = 10
    Caption = 'Click Me'
  end
end`;
      const result = extractFromSource('Form1.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(2);
      expect(components.map((c) => c.name)).toContain('Form1');
      expect(components.map((c) => c.name)).toContain('Button1');

      const button = components.find((c) => c.name === 'Button1');
      expect(button?.signature).toBe('TButton');
    });

    it('should extract nested component hierarchy', () => {
      const code = `object Form1: TForm1
  object Panel1: TPanel
    object Label1: TLabel
      Caption = 'Hello'
    end
  end
end`;
      const result = extractFromSource('Form1.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(3);

      // Check nesting: Panel1 contains Label1
      const panel = components.find((c) => c.name === 'Panel1');
      const label = components.find((c) => c.name === 'Label1');
      const containsEdge = result.edges.find(
        (e) => e.source === panel?.id && e.target === label?.id && e.kind === 'contains'
      );
      expect(containsEdge).toBeDefined();
    });

    it('should extract event handler references', () => {
      const code = `object Form1: TForm1
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
      const result = extractFromSource('Form1.dfm', code);

      const refs = result.unresolvedReferences;
      expect(refs.length).toBe(3);
      expect(refs.map((r) => r.referenceName)).toContain('FormCreate');
      expect(refs.map((r) => r.referenceName)).toContain('FormDestroy');
      expect(refs.map((r) => r.referenceName)).toContain('Button1Click');
      expect(refs.every((r) => r.referenceKind === 'references')).toBe(true);
    });

    it('should handle multi-line properties', () => {
      const code = `object Form1: TForm1
  SQL.Strings = (
    'SELECT * FROM users'
    'WHERE active = 1')
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
      const result = extractFromSource('Form1.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(2);

      const refs = result.unresolvedReferences;
      expect(refs.length).toBe(1);
      expect(refs[0]?.referenceName).toBe('Button1Click');
    });

    it('should handle inherited keyword', () => {
      const code = `inherited Form1: TForm1
  Caption = 'Inherited Form'
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
      const result = extractFromSource('Form1.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(2);
      expect(components.map((c) => c.name)).toContain('Form1');
    });

    it('should handle item collection properties', () => {
      const code = `object Form1: TForm1
  object StatusBar1: TStatusBar
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;
      const result = extractFromSource('Form1.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(2);
    });

    describe('Full fixture: MainForm.dfm', () => {
      const code = `object frmMain: TfrmMain
  Left = 0
  Top = 0
  Caption = 'CodeGraph DFM Fixture'
  ClientHeight = 480
  ClientWidth = 640
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object pnlTop: TPanel
    Left = 0
    Top = 0
    Width = 640
    Height = 50
    object lblTitle: TLabel
      Left = 16
      Top = 16
      Caption = 'Authentication Service'
    end
    object btnLogin: TButton
      Left = 540
      Top = 12
      OnClick = btnLoginClick
    end
  end
  object pnlContent: TPanel
    Left = 0
    Top = 50
    object edtUsername: TEdit
      Left = 16
      Top = 16
      OnChange = edtUsernameChange
    end
    object edtPassword: TEdit
      Left = 16
      Top = 48
      OnKeyPress = edtPasswordKeyPress
    end
    object mmoLog: TMemo
      Left = 16
      Top = 88
    end
  end
  object pnlStatus: TStatusBar
    Left = 0
    Top = 440
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;

      it('should extract all components', () => {
        const result = extractFromSource('MainForm.dfm', code);

        const components = result.nodes.filter((n) => n.kind === 'component');
        expect(components.length).toBe(9);
        expect(components.map((c) => c.name)).toEqual(
          expect.arrayContaining([
            'frmMain', 'pnlTop', 'lblTitle', 'btnLogin',
            'pnlContent', 'edtUsername', 'edtPassword', 'mmoLog', 'pnlStatus',
          ])
        );
      });

      it('should extract all event handlers', () => {
        const result = extractFromSource('MainForm.dfm', code);

        const refs = result.unresolvedReferences;
        expect(refs.length).toBe(5);
        expect(refs.map((r) => r.referenceName)).toEqual(
          expect.arrayContaining([
            'FormCreate', 'FormDestroy', 'btnLoginClick',
            'edtUsernameChange', 'edtPasswordKeyPress',
          ])
        );
      });
    });
  });
}
