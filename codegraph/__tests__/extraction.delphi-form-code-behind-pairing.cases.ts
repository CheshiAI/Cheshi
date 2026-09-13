import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerDelphiFormCodeBehindPairingTests(): void {


  describe('Delphi form code-behind pairing', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links a `.dfm` form to its sibling `.pas` code-behind unit', async () => {
      // A Delphi form unit owns its visual form definition via `{$R *.dfm}`, not a
      // `uses` clause — so a `.dfm` used only as a form definition looked orphaned.
      fs.writeFileSync(path.join(tempDir, 'UFRMAbout.dfm'),
        `object FRMAbout: TFRMAbout\n  Caption = 'About'\nend\n`);
      fs.writeFileSync(path.join(tempDir, 'UFRMAbout.pas'),
        `unit UFRMAbout;\ninterface\nuses Forms;\ntype\n  TFRMAbout = class(TForm)\n  end;\nimplementation\n{$R *.dfm}\nend.\n`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const dfm = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('UFRMAbout.dfm'));
      expect(dfm, 'UFRMAbout.dfm file node').toBeDefined();
      const deps = cg.getFileDependents(dfm!.filePath);
      expect(deps.some((p) => p.endsWith('UFRMAbout.pas')), 'the .pas unit links its .dfm form').toBe(true);
    });
  });
}
