#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import path from 'node:path';

import { CODEGRAPH_CLI_LAUNCHER_ENV } from '../codegraph/src/bin/cli-invocation';
import { CODEGRAPH_RUNTIME_ROOT_ENV } from '../codegraph/src/runtime-paths';

const executableDirectory = path.dirname(process.execPath);
const adjacentProductFile = path.join(executableDirectory, '.env.product');
if (!process.env.CHESHI_PRODUCT_FILE && existsSync(adjacentProductFile)) {
  process.env.CHESHI_PRODUCT_FILE = adjacentProductFile;
}
if (!process.env[CODEGRAPH_RUNTIME_ROOT_ENV] && existsSync(path.join(executableDirectory, 'schema.sql'))) {
  process.env[CODEGRAPH_RUNTIME_ROOT_ENV] = executableDirectory;
}

const { product } = await import('../config/product.mts');

const HELP = `Cheshi CLI

Usage:
  cheshi-cli <command> [options]

Commands:
  codegraph    Initialize, update, and inspect Workspace code indexes
  version      Print the Cheshi version
  help         Show this help

Examples:
  cheshi-cli codegraph init /absolute/path/to/workspace
  cheshi-cli codegraph status /absolute/path/to/workspace --json
  cheshi-cli codegraph sync --quiet /absolute/path/to/workspace
`;

function printHelp(): void {
  process.stdout.write(HELP);
}

function failUnknownCommand(command: string): never {
  process.stderr.write(`Unknown command: ${command}\n\n`);
  process.stderr.write(HELP);
  process.exit(1);
}

async function runCodeGraph(args: string[]): Promise<void> {
  process.env.CODEGRAPH_CLI_NAME = 'cheshi-cli codegraph';
  process.env[CODEGRAPH_CLI_LAUNCHER_ENV] ??= 'cheshi-cli';
  process.argv = [process.argv[0]!, process.argv[1]!, ...(args.length > 0 ? args : ['--help'])];
  await import('../codegraph/src/bin/cheshi-codegraph.ts');
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case undefined:
  case 'help':
  case '-h':
  case '--help':
    if (args[0] === 'codegraph') await runCodeGraph(['--help']);
    else printHelp();
    break;
  case 'version':
  case '-v':
  case '-V':
  case '--version':
    process.stdout.write(`${product.version}\n`);
    break;
  case 'codegraph':
    await runCodeGraph(args);
    break;
  default:
    failUnknownCommand(command);
}
