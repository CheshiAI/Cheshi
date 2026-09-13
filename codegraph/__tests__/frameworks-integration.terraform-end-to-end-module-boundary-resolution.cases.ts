import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerTerraformEndToEndModuleBoundaryResolutionTests(): void {


  describe('Terraform end-to-end module-boundary resolution', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    function writeMultiModuleRepo(root: string) {
      fs.mkdirSync(path.join(root, 'modules/vpc'), { recursive: true });
      fs.mkdirSync(path.join(root, 'modules/other'), { recursive: true });
      fs.mkdirSync(path.join(root, 'envs'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'main.tf'),
        'variable "vpc_cidr" {\n  type = string\n}\n\n' +
        'module "vpc" {\n  source = "./modules/vpc"\n  cidr   = var.vpc_cidr\n}\n\n' +
        'module "registry_thing" {\n  source  = "terraform-aws-modules/s3-bucket/aws"\n  bucket  = "x"\n}\n\n' +
        'output "vpc_id" {\n  value = module.vpc.vpc_id\n}\n'
      );
      fs.writeFileSync(
        path.join(root, 'modules/vpc/variables.tf'),
        'variable "cidr" {\n  type = string\n}\n'
      );
      fs.writeFileSync(
        path.join(root, 'modules/vpc/main.tf'),
        'resource "aws_vpc" "this" {\n  cidr_block = var.cidr\n}\n'
      );
      fs.writeFileSync(
        path.join(root, 'modules/vpc/outputs.tf'),
        'output "vpc_id" {\n  value = aws_vpc.this.id\n}\n'
      );
      // Same-named variable in an UNRELATED module — must never receive edges
      // from outside its own directory.
      fs.writeFileSync(
        path.join(root, 'modules/other/variables.tf'),
        'variable "cidr" {\n  type = string\n}\nvariable "orphan_ref_target" {}\n'
      );
      // References a variable that has no same-dir declaration: must stay unlinked.
      fs.writeFileSync(
        path.join(root, 'modules/other/main.tf'),
        'resource "aws_eip" "e" {\n  tags = { Name = var.undeclared_here_elsewhere_yes }\n}\n'
      );
      fs.writeFileSync(path.join(root, 'envs/prod.tfvars'), 'vpc_cidr = "10.0.0.0/16"\n');
    }

    it('bridges module inputs/outputs/source and enforces directory scoping', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-terraform-'));
      writeMultiModuleRepo(tmpDir);

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();
      try {
        const byQname = (q: string, file?: string) =>
          cg
            .getNodesByName(q.split('.').pop()!)
            .filter((n) => n.qualifiedName === q && (!file || n.filePath === file));

        const moduleDecl = byQname('module.vpc')[0];
        expect(moduleDecl, 'module.vpc declaration node').toBeDefined();
        const childCidr = byQname('var.cidr', 'modules/vpc/variables.tf')[0];
        expect(childCidr, "child module's var.cidr").toBeDefined();
        const childOutput = byQname('output.vpc_id', 'modules/vpc/outputs.tf')[0];
        expect(childOutput, "child module's output.vpc_id").toBeDefined();
        const rootOutput = byQname('output.vpc_id', 'main.tf')[0];
        expect(rootOutput, 'root output.vpc_id').toBeDefined();

        const declEdges = cg.getOutgoingEdges(moduleDecl!.id);
        // Input wiring: module block → child variable (cross-directory).
        expect(
          declEdges.find((e) => e.target === childCidr!.id),
          'module.vpc → child var.cidr input edge'
        ).toBeDefined();
        // Source wiring: module block → child entry file.
        const fileNode = cg
          .getNodesInFile('modules/vpc/main.tf')
          .find((n) => n.kind === 'file');
        expect(fileNode).toBeDefined();
        const importEdge = declEdges.find((e) => e.target === fileNode!.id);
        expect(importEdge, 'module.vpc → modules/vpc/main.tf imports edge').toBeDefined();
        expect(importEdge!.kind).toBe('imports');

        // Output bridge: root output → child output (not just the declaration).
        const rootOutEdges = cg.getOutgoingEdges(rootOutput!.id);
        expect(
          rootOutEdges.find((e) => e.target === childOutput!.id),
          'root output.vpc_id → child output.vpc_id'
        ).toBeDefined();
        expect(
          rootOutEdges.find((e) => e.target === moduleDecl!.id),
          'root output.vpc_id → module.vpc declaration'
        ).toBeDefined();

        // tfvars assignment walks up to the ROOT variable.
        const rootVar = byQname('var.vpc_cidr', 'main.tf')[0];
        expect(rootVar).toBeDefined();
        const tfvarsFile = cg.getNodesInFile('envs/prod.tfvars').find((n) => n.kind === 'file');
        expect(tfvarsFile).toBeDefined();
        expect(
          cg.getOutgoingEdges(tfvarsFile!.id).find((e) => e.target === rootVar!.id),
          'envs/prod.tfvars → var.vpc_cidr'
        ).toBeDefined();

        // Directory scoping: the unrelated module's same-named var.cidr gets
        // NO incoming edges from outside its own directory…
        const otherCidr = byQname('var.cidr', 'modules/other/variables.tf')[0];
        expect(otherCidr).toBeDefined();
        const incomingOther = cg.getIncomingEdges(otherCidr!.id).filter((e) => e.kind !== 'contains');
        expect(incomingOther, 'unrelated module var.cidr must stay isolated').toHaveLength(0);

        // …and a reference with no same-dir declaration stays unlinked rather
        // than borrowing another module's declaration.
        const orphanEdges = cg
          .getNodesInFile('modules/other/main.tf')
          .filter((n) => n.qualifiedName === 'aws_eip.e')
          .flatMap((n) => cg.getOutgoingEdges(n.id))
          .filter((e) => e.kind === 'references');
        const orphanTargets = orphanEdges.map((e) => cg.getNode(e.target)?.qualifiedName);
        expect(orphanTargets).not.toContain('var.undeclared_here_elsewhere_yes');

        // Registry-sourced module: inputs stay unresolved (no guessed edges).
        const registryDecl = byQname('module.registry_thing')[0];
        expect(registryDecl).toBeDefined();
        const registryEdges = cg
          .getOutgoingEdges(registryDecl!.id)
          .filter((e) => e.kind !== 'contains');
        expect(registryEdges, 'registry module must not link anywhere').toHaveLength(0);
      } finally {
        cg.close();
      }
    });
  });
}
