import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerVbNetExtractionScannerBackedConstructsTests(): void {


  describe('VB.NET Extraction — scanner-backed constructs', () => {
    it('should parse XML literals as opaque literals without breaking siblings', () => {
      const code = `Class Muxer
    Function WriteTags() As Object
        Dim xml = <Tags>
                      <%= From tag In Tags Select <Tag><Name><%= tag.Name %></Name></Tag> %>
                  </Tags>
        Return xml
    End Function

    Sub After()
        Log("still extracted")
    End Sub
End Class
`;
      const result = extractFromSource('Muxer.vb', code);
      const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
      expect(methods).toEqual(expect.arrayContaining(['WriteTags', 'After']));
    });

    it('should parse multi-line LINQ query clauses', () => {
      const code = `Class T
    Function Big() As Integer
        Dim big = From l In _lines
                  Where l.Length > 3
                  Select l.Length
        Return big.Sum()
    End Function
End Class
`;
      const result = extractFromSource('Linq.vb', code);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
      expect(calls).toContain('big.Sum');
      expect(result.nodes.find((n) => n.kind === 'method')?.name).toBe('Big');
    });

    it('should extract MustOverride members without derailing following members', () => {
      const code = `MustInherit Class VideoEncoder
    MustOverride ReadOnly Property OutputExt As String

    Public MustOverride Sub ShowConfigDialog(Optional param As Object = Nothing)

    MustOverride Function GetError() As String

    Sub New()
        CanEdit = True
    End Sub
End Class
`;
      const result = extractFromSource('VideoEncoder.vb', code);
      const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
      expect(methods).toEqual(expect.arrayContaining(['ShowConfigDialog', 'GetError', 'New']));
      const props = result.nodes.filter((n) => n.kind === 'property').map((n) => n.name);
      expect(props).toContain('OutputExt');
    });

    it('should parse nullable declarator shorthand (Dim x? = expr)', () => {
      const code = `Class T
    Sub M(folderInfo As Object)
        Dim SteamFolderData? = Parser.GetSteamNameAndID(folderInfo)
        Use(SteamFolderData)
    End Sub
End Class
`;
      const result = extractFromSource('Factory.vb', code);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
      expect(calls).toContain('Parser.GetSteamNameAndID');
    });
  });
}
