import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerTerraformFollowUpsRemoteStateBridgeProviderAliasMovedBlocksTests(): void {


  describe('Terraform follow-ups: remote-state bridge, provider alias, moved blocks', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('bridges atmos remote-state to the target component, resolves provider aliases up the tree, links moved blocks', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-terraform-fu-'));
      // Component producing state.
      fs.mkdirSync(path.join(tmpDir, 'components/terraform/vpc'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'components/terraform/vpc/outputs.tf'),
        'output "vpc_id" {\n  value = "vpc-123"\n}\n'
      );
      // Component consuming it via the cloudposse remote-state module.
      fs.mkdirSync(path.join(tmpDir, 'components/terraform/eks/cluster'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'components/terraform/eks/cluster/remote-state.tf'),
        'module "vpc" {\n' +
        '  source    = "cloudposse/stack-config/yaml//modules/remote-state"\n' +
        '  component = var.vpc_component_name\n' +
        '}\n' +
        'variable "vpc_component_name" {\n' +
        '  type    = string\n' +
        '  default = "vpc"\n' +
        '}\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'components/terraform/eks/cluster/main.tf'),
        'resource "aws_eks_cluster" "this" {\n  vpc_id = module.vpc.outputs.vpc_id\n}\n'
      );
      // Ambiguous component name — two directories called "dns" with the same
      // output; the bridge must refuse to pick one.
      fs.mkdirSync(path.join(tmpDir, 'components/terraform/dns'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'legacy/dns'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'components/terraform/dns/outputs.tf'), 'output "zone_id" {\n  value = "z1"\n}\n');
      fs.writeFileSync(path.join(tmpDir, 'legacy/dns/outputs.tf'), 'output "zone_id" {\n  value = "z2"\n}\n');
      fs.writeFileSync(
        path.join(tmpDir, 'components/terraform/eks/cluster/dns.tf'),
        'module "dns" {\n' +
        '  source    = "cloudposse/stack-config/yaml//modules/remote-state"\n' +
        '  component = "dns"\n' +
        '}\n' +
        'output "zone" {\n  value = module.dns.outputs.zone_id\n}\n'
      );
      // Provider alias declared at the root, selected inside a module dir.
      fs.writeFileSync(
        path.join(tmpDir, 'providers.tf'),
        'provider "aws" {\n  region = "us-east-1"\n}\n' +
        'provider "aws" {\n  alias  = "east"\n  region = "us-east-2"\n}\n'
      );
      fs.mkdirSync(path.join(tmpDir, 'modules/app'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'modules/app/main.tf'),
        'resource "aws_s3_bucket" "b" {\n  provider = aws.east\n  bucket   = "x"\n}\n'
      );
      // Moved block referencing a live resource.
      fs.writeFileSync(
        path.join(tmpDir, 'main.tf'),
        'resource "aws_instance" "renamed" {}\n' +
        'moved {\n  from = aws_instance.old\n  to   = aws_instance.renamed\n}\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();
      try {
        const byQname = (q: string, file?: string) =>
          cg
            .getNodesByName(q.split('.').pop()!)
            .filter((n) => n.qualifiedName === q && (!file || n.filePath === file));

        // 1. remote-state bridge: consumer resource → producer component's output.
        const consumer = byQname('aws_eks_cluster.this')[0] ??
          cg.getNodesInFile('components/terraform/eks/cluster/main.tf').find((n) => n.qualifiedName === 'aws_eks_cluster.this');
        expect(consumer, 'consumer resource').toBeDefined();
        const producerOut = byQname('output.vpc_id', 'components/terraform/vpc/outputs.tf')[0];
        expect(producerOut, "producer component's output").toBeDefined();
        expect(
          cg.getOutgoingEdges(consumer!.id).find((e) => e.target === producerOut!.id),
          'remote-state bridge edge eks/cluster → vpc output'
        ).toBeDefined();

        // 2. Ambiguous component name → no bridge edge to either candidate.
        const zoneOut = byQname('output.zone', 'components/terraform/eks/cluster/dns.tf')[0];
        expect(zoneOut).toBeDefined();
        const zoneTargets = cg
          .getOutgoingEdges(zoneOut!.id)
          .map((e) => cg.getNode(e.target))
          .filter((n) => n?.qualifiedName === 'output.zone_id');
        expect(zoneTargets, 'ambiguous component must not be guessed').toHaveLength(0);

        // 3. Provider alias: nodes are distinct, and the selection inside the
        //    module resolves up the tree to the aliased configuration.
        const provNodes = cg.getNodesInFile('providers.tf');
        const aliased = provNodes.find((n) => n.qualifiedName === 'provider.aws.east');
        const defaultProv = provNodes.find((n) => n.qualifiedName === 'provider.aws');
        expect(aliased, 'aliased provider node').toBeDefined();
        expect(defaultProv, 'default provider node').toBeDefined();
        const bucket = cg.getNodesInFile('modules/app/main.tf').find((n) => n.qualifiedName === 'aws_s3_bucket.b');
        expect(bucket).toBeDefined();
        const bucketEdges = cg.getOutgoingEdges(bucket!.id);
        expect(
          bucketEdges.find((e) => e.target === aliased!.id),
          'provider = aws.east → aliased provider (ancestor walk)'
        ).toBeDefined();
        expect(bucketEdges.find((e) => e.target === defaultProv!.id), 'must not link the default provider').toBeUndefined();

        // 4. moved block: the file references the live resource.
        const renamed = cg.getNodesInFile('main.tf').find((n) => n.qualifiedName === 'aws_instance.renamed');
        expect(renamed).toBeDefined();
        const rootFile = cg.getNodesInFile('main.tf').find((n) => n.kind === 'file');
        expect(
          cg.getOutgoingEdges(rootFile!.id).find((e) => e.target === renamed!.id),
          'moved block → live resource edge'
        ).toBeDefined();
      } finally {
        cg.close();
      }
    });
  });
}
