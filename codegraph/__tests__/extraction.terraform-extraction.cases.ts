import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerTerraformExtractionTests(): void {


  describe('Terraform Extraction', () => {
    describe('Language detection', () => {
      it('should detect Terraform files', () => {
        expect(detectLanguage('main.tf')).toBe('terraform');
        expect(detectLanguage('terraform.tfvars')).toBe('terraform');
        expect(detectLanguage('versions.tofu')).toBe('terraform');
      });

      it('should report Terraform as supported', () => {
        expect(isLanguageSupported('terraform')).toBe(true);
        expect(getSupportedLanguages()).toContain('terraform');
      });
    });

    describe('Block extraction', () => {
      it('should extract a resource block as a class with qualified type.name', () => {
        const code = `
resource "aws_s3_bucket" "my_bucket" {
  bucket = "example"
}
`;
        const result = extractFromSource('main.tf', code);
        const res = result.nodes.find((n) => n.name === 'aws_s3_bucket.my_bucket');
        expect(res).toBeDefined();
        expect(res?.kind).toBe('class');
        expect(res?.qualifiedName).toBe('aws_s3_bucket.my_bucket');
        expect(res?.signature).toBe('resource "aws_s3_bucket" "my_bucket"');
        expect(res?.language).toBe('terraform');
      });

      it('should extract a data block under the data.* qualified name', () => {
        const code = `
data "aws_caller_identity" "current" {}
`;
        const result = extractFromSource('main.tf', code);
        const node = result.nodes.find((n) => n.qualifiedName === 'data.aws_caller_identity.current');
        expect(node).toBeDefined();
        expect(node?.kind).toBe('class');
      });

      it('should extract a variable block as variable with qualified name var.X', () => {
        const code = `
variable "region" {
  type    = string
  default = "us-east-1"
}
`;
        const result = extractFromSource('variables.tf', code);
        const v = result.nodes.find((n) => n.qualifiedName === 'var.region');
        expect(v).toBeDefined();
        expect(v?.kind).toBe('variable');
        expect(v?.name).toBe('region');
      });

      it('should extract an output block as variable with qualified name output.X', () => {
        const code = `
output "bucket_arn" {
  value = aws_s3_bucket.my_bucket.arn
}
`;
        const result = extractFromSource('outputs.tf', code);
        const out = result.nodes.find((n) => n.qualifiedName === 'output.bucket_arn');
        expect(out).toBeDefined();
        expect(out?.kind).toBe('variable');
      });

      it('should extract a module block as module with qualified name module.X', () => {
        const code = `
module "vpc" {
  source = "./modules/vpc"
  cidr   = var.vpc_cidr
}
`;
        const result = extractFromSource('main.tf', code);
        const m = result.nodes.find((n) => n.qualifiedName === 'module.vpc');
        expect(m).toBeDefined();
        expect(m?.kind).toBe('module');
      });

      it('should extract a provider block as namespace', () => {
        const code = `
provider "aws" {
  region = "us-east-1"
}
`;
        const result = extractFromSource('main.tf', code);
        const p = result.nodes.find((n) => n.qualifiedName === 'provider.aws');
        expect(p).toBeDefined();
        expect(p?.kind).toBe('namespace');
      });

      it('should extract every locals attribute as its own constant with local.K qualified name', () => {
        const code = `
locals {
  prefix      = "prod"
  full_name   = "\${local.prefix}-app"
  max_retries = 3
}
`;
        const result = extractFromSource('locals.tf', code);
        const names = result.nodes
          .filter((n) => n.kind === 'constant')
          .map((n) => n.qualifiedName)
          .sort();
        expect(names).toEqual(['local.full_name', 'local.max_retries', 'local.prefix']);
      });

      it('should ignore a terraform settings block', () => {
        const code = `
terraform {
  required_version = ">= 1.5"
}
`;
        const result = extractFromSource('versions.tf', code);
        const symbols = result.nodes.filter((n) => n.kind !== 'file');
        expect(symbols).toHaveLength(0);
      });

      it('should index .tfvars top-level attributes via the same parser path', () => {
        // .tfvars files have no blocks — just bare attributes, each of which
        // SETS the root module variable of that name. No symbols are declared,
        // but every top-level assignment references its variable so "what sets
        // var.region" is answerable.
        const code = `
region      = "us-east-1"
environment = "prod"
`;
        const result = extractFromSource('terraform.tfvars', code);
        expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
        const symbols = result.nodes.filter((n) => n.kind !== 'file');
        expect(symbols).toHaveLength(0);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('var.region');
        expect(refs).toContain('var.environment');
      });
    });

    describe('Reference extraction', () => {
      it('should emit a reference for var.X used inside a resource', () => {
        const code = `
variable "region" {}
resource "aws_s3_bucket" "b" {
  bucket = var.region
}
`;
        const result = extractFromSource('main.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('var.region');
      });

      it('should emit a reference for module.M.<output> as module.M', () => {
        const code = `
output "vpc_id" {
  value = module.vpc.vpc_id
}
`;
        const result = extractFromSource('outputs.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('module.vpc');
      });

      it('should emit a scoped module.M:output.X ref alongside module.M for output chains', () => {
        const code = `
output "vpc_id" {
  value = module.vpc.vpc_id
}
`;
        const result = extractFromSource('outputs.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('module.vpc:output.vpc_id');
        // A bare module.M use (no output segment) stays a single ref.
        const bare = extractFromSource('main.tf', 'output "m" {\n  value = module.vpc\n}\n');
        const bareRefs = bare.unresolvedReferences.map((r) => r.referenceName);
        expect(bareRefs).toContain('module.vpc');
        expect(bareRefs.some((r) => r.includes(':output.'))).toBe(false);
      });

      it('should wire module blocks: scoped input refs, meta-args skipped, local source imported', () => {
        const code = `
module "vpc" {
  source     = "./modules/vpc"
  version    = "1.0.0"
  count      = 2
  depends_on = [aws_iam_role.net]
  cidr       = var.vpc_cidr
  name       = "prod"
}
`;
        const result = extractFromSource('main.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        // Input attributes wire to the child module's variables (scoped spelling).
        expect(refs).toContain('module.vpc:var.cidr');
        expect(refs).toContain('module.vpc:var.name');
        // Meta-arguments configure the call, not child variables.
        expect(refs).not.toContain('module.vpc:var.source');
        expect(refs).not.toContain('module.vpc:var.version');
        expect(refs).not.toContain('module.vpc:var.count');
        expect(refs).not.toContain('module.vpc:var.depends_on');
        // A local ./ source emits the module→file imports ref.
        const fileRef = result.unresolvedReferences.find((r) => r.referenceName === 'module.vpc:file');
        expect(fileRef).toBeDefined();
        expect(fileRef?.referenceKind).toBe('imports');
        // Attribute VALUES still reference the parent scope as before.
        expect(refs).toContain('var.vpc_cidr');
        expect(refs).toContain('aws_iam_role.net');
      });

      it('should not emit a module.M:file ref for registry or git sources', () => {
        const code = `
module "s3" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "4.0.0"
  bucket  = "x"
}
module "net" {
  source = "git::https://example.com/net.git"
  cidr   = "10.0.0.0/16"
}
`;
        const result = extractFromSource('main.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs.some((r) => r.endsWith(':file'))).toBe(false);
        // Input wiring is still emitted — the resolver drops it when the
        // source turns out to be out-of-repo.
        expect(refs).toContain('module.s3:var.bucket');
      });

      it('should emit a remote-output candidate for module.M.outputs.X chains', () => {
        const code = `
resource "aws_eks_cluster" "this" {
  vpc_id = module.vpc.outputs.vpc_id
}
`;
        const result = extractFromSource('main.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('module.vpc');
        expect(refs).toContain('module.vpc:remote-output.vpc_id');
        // A plain two-segment chain must NOT produce a remote-output candidate.
        const plain = extractFromSource('o.tf', 'output "x" {\n  value = module.vpc.vpc_id\n}\n');
        const plainRefs = plain.unresolvedReferences.map((r) => r.referenceName);
        expect(plainRefs.some((r) => r.includes(':remote-output.'))).toBe(false);
      });

      it('should reference resource addresses from moved/import/removed blocks, anchored to the file', () => {
        const code = `
resource "aws_instance" "new" {}
moved {
  from = aws_instance.old
  to   = aws_instance.new
}
import {
  to = aws_s3_bucket.b
  id = "bucket-name"
}
removed {
  from = module.legacy.aws_iam_role.r
}
`;
        const result = extractFromSource('main.tf', code);
        const refs = result.unresolvedReferences;
        const names = refs.map((r) => r.referenceName);
        expect(names).toContain('aws_instance.old');
        expect(names).toContain('aws_instance.new');
        expect(names).toContain('aws_s3_bucket.b');
        expect(names).toContain('module.legacy');
        // Scoped module refs are suppressed here: module.legacy.aws_iam_role.r
        // names a resource inside a module instance, never a module output.
        expect(names.some((n) => n.includes(':'))).toBe(false);
        // Anchored to the file node, and no phantom symbols were declared.
        const fileNode = result.nodes.find((n) => n.kind === 'file');
        expect(fileNode).toBeDefined();
        for (const r of refs.filter((x) => x.referenceName === 'aws_instance.old')) {
          expect(r.fromNodeId).toBe(fileNode!.id);
        }
        expect(result.nodes.filter((n) => n.kind !== 'file')).toHaveLength(1); // just aws_instance.new
      });

      it('should collect check-assert condition references and still index check-scoped data blocks', () => {
        const code = `
check "health" {
  data "http" "ping" {
    url = var.endpoint
  }
  assert {
    condition     = data.http.ping.status_code == 200 && var.strict
    error_message = "unhealthy"
  }
}
`;
        const result = extractFromSource('checks.tf', code);
        const names = result.unresolvedReferences.map((r) => r.referenceName);
        expect(names).toContain('data.http.ping');
        expect(names).toContain('var.strict');
        expect(names).toContain('var.endpoint');
        // The scoped data source inside the check is a real symbol.
        expect(result.nodes.find((n) => n.qualifiedName === 'data.http.ping')).toBeDefined();
      });

      it('should qualify aliased provider blocks and reference provider selections', () => {
        const code = `
provider "aws" {
  region = "us-east-1"
}
provider "aws" {
  alias  = "east"
  region = "us-east-2"
}
resource "aws_s3_bucket" "b" {
  provider = aws.east
  bucket   = "x"
}
resource "google_service_account" "sa" {
  provider = google-beta
}
`;
        const result = extractFromSource('main.tf', code);
        const providers = result.nodes.filter((n) => n.kind === 'namespace').map((n) => n.qualifiedName).sort();
        expect(providers).toEqual(['provider.aws', 'provider.aws.east']);
        const names = result.unresolvedReferences.map((r) => r.referenceName);
        expect(names).toContain('provider.aws.east');
        expect(names).toContain('provider.google-beta');
        // The selection must not be misread as a resource reference.
        expect(names).not.toContain('aws.east');
      });

      it('should reference the values (not keys) of a module providers map', () => {
        const code = `
module "vpc" {
  source    = "./modules/vpc"
  providers = {
    aws = aws.east
  }
}
`;
        const result = extractFromSource('main.tf', code);
        const names = result.unresolvedReferences.map((r) => r.referenceName);
        expect(names).toContain('provider.aws.east');
        expect(names).not.toContain('provider.aws');
        expect(names).not.toContain('aws.east');
        // providers is a meta-argument — no input wiring for it.
        expect(names).not.toContain('module.vpc:var.providers');
      });

      it('should emit data.T.N references stripped of the trailing attribute', () => {
        const code = `
output "account" {
  value = data.aws_caller_identity.current.account_id
}
`;
        const result = extractFromSource('outputs.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('data.aws_caller_identity.current');
      });

      it('should emit T.N references for managed-resource attribute access', () => {
        const code = `
resource "aws_iam_policy" "p" {
  policy = aws_s3_bucket.my.arn
}
`;
        const result = extractFromSource('main.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('aws_s3_bucket.my');
      });

      it('should emit local.K references from locals attribute expressions', () => {
        const code = `
locals {
  prefix = "prod"
  name   = "\${local.prefix}-app"
}
`;
        const result = extractFromSource('locals.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        expect(refs).toContain('local.prefix');
      });

      it('should skip built-in heads (each, count, self, path, terraform.workspace)', () => {
        const code = `
resource "aws_instance" "x" {
  count       = each.value
  name        = path.module
  workspace   = terraform.workspace
  self_ref    = self.id
  index_value = count.index
}
`;
        const result = extractFromSource('main.tf', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        // None of the built-ins should produce project references.
        expect(refs.some((r) => r.startsWith('each.'))).toBe(false);
        expect(refs.some((r) => r.startsWith('count.'))).toBe(false);
        expect(refs.some((r) => r.startsWith('self.'))).toBe(false);
        expect(refs.some((r) => r.startsWith('path.'))).toBe(false);
        expect(refs.some((r) => r.startsWith('terraform.'))).toBe(false);
      });
    });
  });
}
