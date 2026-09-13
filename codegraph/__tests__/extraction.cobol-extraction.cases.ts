import { extractFromSource } from '../src/extraction';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerCobolExtractionTests(): void {


  describe('COBOL Extraction', () => {
    it('should detect .cbl/.cob/.cpy as cobol (case-insensitive)', () => {
      expect(detectLanguage('app/cbl/CBACT01C.cbl')).toBe('cobol');
      expect(detectLanguage('app/cbl/CBSTM03A.CBL')).toBe('cobol');
      expect(detectLanguage('prog.cob')).toBe('cobol');
      expect(detectLanguage('app/cpy/CVACT01Y.cpy')).toBe('cobol');
      expect(isSourceFile('CBACT01C.cbl')).toBe(true);
    });

    const FIXED = (body: string) =>
      body
        .split('\n')
        .map((l) => (l.length > 0 ? '       ' + l : l))
        .join('\n');

    const PROGRAM = FIXED(`IDENTIFICATION DIVISION.
PROGRAM-ID. TESTPROG.
DATA DIVISION.
WORKING-STORAGE SECTION.
01  WS-TOTALS.
    05  WS-COUNT            PIC 9(4) VALUE ZERO.
    88  WS-DONE             VALUE 'Y'.
77  WS-FLAG                 PIC X.
COPY CVACT01Y.
PROCEDURE DIVISION.
MAIN-SECTION SECTION.
0000-MAIN.
    PERFORM 1000-INIT
    PERFORM 2000-PROCESS THRU 2000-EXIT
    CALL 'CBACT01C' USING WS-TOTALS
    CALL WS-FLAG
    GO TO 9999-END
    .
1000-INIT.
    MOVE ZERO TO WS-COUNT.
2000-PROCESS.
    EXEC CICS LINK PROGRAM('COCOM01C') COMMAREA(WS-TOTALS)
    END-EXEC.
2000-EXIT.
    EXIT.
9999-END.
    GOBACK.
`);

    it('should extract the program as a module node', () => {
      const result = extractFromSource('TESTPROG.cbl', PROGRAM);
      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('TESTPROG');
    });

    it('should extract sections and paragraphs as functions with reconstructed extents', () => {
      const result = extractFromSource('TESTPROG.cbl', PROGRAM);
      const fns = result.nodes.filter((n) => n.kind === 'function');
      const names = fns.map((f) => f.name);
      expect(names).toContain('MAIN-SECTION');
      expect(names).toContain('0000-MAIN');
      expect(names).toContain('2000-PROCESS');
      // A paragraph spans from its header to the next header, not just one line.
      const main = fns.find((f) => f.name === '0000-MAIN');
      expect(main).toBeDefined();
      expect(main!.endLine).toBeGreaterThan(main!.startLine + 3);
      // Paragraphs are contained in their section (qualified name includes it).
      expect(main!.qualifiedName).toContain('MAIN-SECTION');
    });

    it('should extract PERFORM, PERFORM THRU, GO TO, and CALL literal as calls references', () => {
      const result = extractFromSource('TESTPROG.cbl', PROGRAM);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      const targets = calls.map((c) => c.referenceName);
      expect(targets).toContain('1000-INIT');
      expect(targets).toContain('2000-PROCESS'); // PERFORM ... THRU start
      expect(targets).toContain('2000-EXIT'); // PERFORM ... THRU end
      expect(targets).toContain('9999-END'); // GO TO
      expect(targets).toContain('CBACT01C'); // CALL 'literal'
      expect(targets).toContain('COCOM01C'); // EXEC CICS LINK PROGRAM('...')
      // Dynamic CALL through a data name is skipped — announce, don't guess.
      expect(targets).not.toContain('WS-FLAG');
    });

    it('should extract COPY as an import node and imports reference', () => {
      const result = extractFromSource('TESTPROG.cbl', PROGRAM);
      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('CVACT01Y');
      const importRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
      expect(importRefs.map((r) => r.referenceName)).toContain('CVACT01Y');
    });

    it('should extract data items as variables, fields, and 88-level constants', () => {
      const result = extractFromSource('TESTPROG.cbl', PROGRAM);
      const group = result.nodes.find((n) => n.name === 'WS-TOTALS');
      expect(group?.kind).toBe('variable');
      const nested = result.nodes.find((n) => n.name === 'WS-COUNT');
      expect(nested?.kind).toBe('field');
      expect(nested?.qualifiedName).toContain('WS-TOTALS');
      const condition = result.nodes.find((n) => n.name === 'WS-DONE');
      expect(condition?.kind).toBe('constant');
      const standalone = result.nodes.find((n) => n.name === 'WS-FLAG');
      expect(standalone?.kind).toBe('variable');
    });

    it('should extract EXEC SQL INCLUDE as an import', () => {
      const code = FIXED(`IDENTIFICATION DIVISION.
PROGRAM-ID. SQLPROG.
DATA DIVISION.
WORKING-STORAGE SECTION.
EXEC SQL INCLUDE SQLCA END-EXEC.
01  WS-X                    PIC X.
PROCEDURE DIVISION.
P1.
    GOBACK.
`);
      const result = extractFromSource('SQLPROG.cbl', code);
      const importNode = result.nodes.find((n) => n.kind === 'import' && n.name === 'SQLCA');
      expect(importNode).toBeDefined();
      // The EXEC block must not break the rest of the file.
      expect(result.nodes.find((n) => n.name === 'WS-X')).toBeDefined();
    });

    it('should extract a standalone data copybook (.cpy fragment)', () => {
      const code = FIXED(`01  ACCOUNT-RECORD.
    05  ACCT-ID             PIC 9(11).
    05  ACCT-CURR-BAL       PIC S9(10)V99.
`);
      const result = extractFromSource('CVACT01Y.cpy', code);
      const record = result.nodes.find((n) => n.name === 'ACCOUNT-RECORD');
      expect(record?.kind).toBe('variable');
      const field = result.nodes.find((n) => n.name === 'ACCT-ID');
      expect(field?.kind).toBe('field');
    });

    it('should extract a procedure copybook (.cpy fragment with paragraphs)', () => {
      const code = FIXED(`EDIT-DATE.
    MOVE 1 TO WS-X
    PERFORM VALIDATE-YEAR.
VALIDATE-YEAR.
    CONTINUE.
`);
      const result = extractFromSource('CSUTLDPY.cpy', code);
      const fns = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(fns).toContain('EDIT-DATE');
      expect(fns).toContain('VALIDATE-YEAR');
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      expect(calls.map((c) => c.referenceName)).toContain('VALIDATE-YEAR');
    });

    it('should emit write-site references for MOVE/ADD/COMPUTE targets', () => {
      const code = FIXED(`IDENTIFICATION DIVISION.
PROGRAM-ID. WRITEREF.
DATA DIVISION.
WORKING-STORAGE SECTION.
01  WS-TOTAL                 PIC S9(7)V99.
01  WS-COUNT                 PIC 9(4).
PROCEDURE DIVISION.
P1.
    MOVE ZERO TO WS-TOTAL
    ADD 1 TO WS-COUNT
    COMPUTE WS-TOTAL = WS-TOTAL + 1
    SUBTRACT 1 FROM WS-COUNT
    MOVE 1 TO RETURN-CODE.
`);
      const result = extractFromSource('WRITEREF.cbl', code);
      const writes = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
      const names = writes.map((w) => w.referenceName);
      expect(names.filter((n) => n === 'WS-TOTAL').length).toBeGreaterThanOrEqual(2); // MOVE + COMPUTE
      expect(names).toContain('WS-COUNT'); // ADD and SUBTRACT targets
      // Special registers carry no declaration — never referenced.
      expect(names).not.toContain('RETURN-CODE');
    });

    it('should emit cics-transid references for RETURN TRANSID, literal and via same-file VALUE', () => {
      const code = FIXED(`IDENTIFICATION DIVISION.
PROGRAM-ID. TXPROG.
DATA DIVISION.
WORKING-STORAGE SECTION.
01  WS-TRANID                PIC X(04) VALUE 'CB00'.
PROCEDURE DIVISION.
P1.
    EXEC CICS RETURN TRANSID('CC00') COMMAREA(WS-X) END-EXEC
    .
P2.
    EXEC CICS RETURN TRANSID(WS-TRANID) END-EXEC
    .
P3.
    EXEC CICS XCTL PROGRAM(WS-UNKNOWN-VAR) END-EXEC
    .
`);
      const result = extractFromSource('TXPROG.cbl', code);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      const names = calls.map((c) => c.referenceName);
      expect(names).toContain('cics-transid:CC00'); // literal
      expect(names).toContain('cics-transid:CB00'); // dereferenced through WS-TRANID
      // Un-derefable program variable: dynamic dispatch, no guessed edge.
      expect(names.filter((n) => n.startsWith('cics-transid:')).length).toBe(2);
    });

    it('should shift free-format source so it still extracts (preParse)', () => {
      const code = `IDENTIFICATION DIVISION.
PROGRAM-ID. FREEPROG.
PROCEDURE DIVISION.
DO-WORK.
    DISPLAY 'HI'.
`;
      const result = extractFromSource('freeprog.cbl', code);
      expect(result.nodes.find((n) => n.kind === 'module')?.name).toBe('FREEPROG');
      expect(result.nodes.find((n) => n.kind === 'function')?.name).toBe('DO-WORK');
    });
  });
}
