import { extractFromSource } from '../src/extraction';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerVbNetExtractionTests(): void {


  // =============================================================================
  // VB.NET (.vb) — vendored patched govindbanura/tree-sitter-vbnet grammar
  // =============================================================================

  describe('VB.NET Extraction', () => {
    it('should detect .vb as vbnet', () => {
      expect(detectLanguage('Service.vb')).toBe('vbnet');
      expect(detectLanguage('app/Forms/MainForm.vb')).toBe('vbnet');
      expect(isSourceFile('Service.vb')).toBe(true);
    });

    const SAMPLE = `Imports System
Imports System.Collections.Generic

Namespace Acme.Billing

    Public Interface IRepository
        Function GetById(ByVal id As Integer) As Invoice
    End Interface

    Public Enum InvoiceState
        Draft = 0
        Sent
        Paid
    End Enum

    Public Structure Money
        Public Amount As Decimal
    End Structure

    Public MustInherit Class EntityBase
        Public Property Id As Integer
    End Class

    Public Class Invoice
        Inherits EntityBase
        Implements IRepository

        Private ReadOnly _lines As New List(Of String)
        Public Const MaxLines As Integer = 100
        Public Event Paid(ByVal amount As Decimal)

        Public Property State As InvoiceState

        Public Sub New(ByVal id As Integer)
            Me.Id = id
        End Sub

        Public Function GetById(ByVal id As Integer) As Invoice Implements IRepository.GetById
            Return New Invoice(id)
        End Function

        Public Sub AddLine(ByVal description As String)
            _lines.Add(description)
            Validate(description)
        End Sub

        Private Sub Validate(ByVal text As String)
            If text.Length > MaxLines Then Throw New ArgumentException("too long")
        End Sub
    End Class

    ' lowercase keywords: VB is case-insensitive
    public module Helpers
        public function Twice(byval n as integer) as integer
            return n * 2
        end function

        Public Sub Run()
            Dim inv = New Invoice(1)
            inv.AddLine("widget")
            Dim d As New Dictionary(Of String, Integer)
            Helpers.Twice(21)
        End Sub
    end module
End Namespace
`;

    it('should extract classes, modules, interfaces, structures, and enums', () => {
      const result = extractFromSource('Invoice.vb', SAMPLE);
      const kinds = (kind: string) => result.nodes.filter((n) => n.kind === kind).map((n) => n.name);
      expect(kinds('class')).toEqual(expect.arrayContaining(['EntityBase', 'Invoice', 'Helpers']));
      expect(kinds('interface')).toContain('IRepository');
      expect(kinds('struct')).toContain('Money');
      expect(kinds('enum')).toContain('InvoiceState');
      expect(kinds('enum_member')).toEqual(expect.arrayContaining(['Draft', 'Sent', 'Paid']));
    });

    it('should extract methods, constructors, properties, fields, and events (case-insensitive keywords)', () => {
      const result = extractFromSource('Invoice.vb', SAMPLE);
      const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
      expect(methods).toEqual(expect.arrayContaining(['GetById', 'AddLine', 'Validate', 'Twice', 'Run']));
      const props = result.nodes.filter((n) => n.kind === 'property').map((n) => n.name);
      expect(props).toEqual(expect.arrayContaining(['Id', 'State']));
      const fields = result.nodes.filter((n) => n.kind === 'field' || n.kind === 'constant').map((n) => n.name);
      expect(fields).toEqual(expect.arrayContaining(['_lines', 'MaxLines']));
      // Event declarations index as findable members
      expect(fields).toContain('Paid');
    });

    it('should qualify types with their namespace', () => {
      const result = extractFromSource('Invoice.vb', SAMPLE);
      const invoice = result.nodes.find((n) => n.kind === 'class' && n.name === 'Invoice');
      expect(invoice?.qualifiedName).toContain('Acme.Billing');
    });

    it('should emit Inherits as extends and Implements as implements references', () => {
      const result = extractFromSource('Invoice.vb', SAMPLE);
      const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
      expect(extendsRefs.map((r) => r.referenceName)).toContain('EntityBase');
      const implementsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'implements');
      expect(implementsRefs.map((r) => r.referenceName)).toContain('IRepository');
    });

    it('should extract calls through both invocation and index-shaped parens', () => {
      const result = extractFromSource('Invoice.vb', SAMPLE);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
      // `_lines.Add(description)` parses as array_access (non-empty parens) — still a call site
      expect(calls).toContain('_lines.Add');
      // bare call with args
      expect(calls).toContain('Validate');
      // qualified module call
      expect(calls).toContain('Helpers.Twice');
    });

    it('should emit instantiates for New, with VB generic syntax stripped', () => {
      const result = extractFromSource('Invoice.vb', SAMPLE);
      const insts = result.unresolvedReferences.filter((r) => r.referenceKind === 'instantiates').map((r) => r.referenceName);
      expect(insts).toContain('Invoice');
      // `As New Dictionary(Of String, Integer)` → bare type name, not `Dictionary(Of ...)`
      expect(insts.some((n) => n.includes('(') || /\bOf\b/.test(n))).toBe(false);
    });

    it('should extract Imports as import nodes', () => {
      const result = extractFromSource('Invoice.vb', SAMPLE);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toEqual(expect.arrayContaining(['System', 'System.Collections.Generic']));
    });

    it('should parse a file without a trailing newline (preParse guard)', () => {
      const code = 'Class Tail\n    Sub Go()\n        Log("x")\n    End Sub\nEnd Class';
      const result = extractFromSource('Tail.vb', code);
      expect(result.nodes.find((n) => n.kind === 'class')?.name).toBe('Tail');
      expect(result.nodes.find((n) => n.kind === 'method')?.name).toBe('Go');
    });
  });
}
