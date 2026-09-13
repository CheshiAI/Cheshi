#!/usr/bin/env bun

import path from 'node:path';

import { findNearestCodeGraphRoot } from '@cheshi/codegraph';
import { Command } from 'commander';

import { startCodeGraphServer } from './server';

interface CodeGraphServerCliOptions {
  port?: string;
  host?: string;
  project?: string[];
}

function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());
  return findNearestCodeGraphRoot(absolutePath) ?? absolutePath;
}

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value || '4317', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

const program = new Command()
  .name('cheshi-codegraph-server')
  .description('Start the local Cheshi CodeGraph server')
  .argument('[path]', 'Indexed project path')
  .option('-p, --port <number>', 'Port to listen on', '4317')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('--project <path...>', 'Additional indexed project to expose in the project selector');

program.action(async (pathArg: string | undefined, options: CodeGraphServerCliOptions) => {
  try {
    const projectPath = resolveProjectPath(pathArg);
    const additionalProjects = (options.project ?? []).map((project) => resolveProjectPath(project));
    const port = parsePort(options.port);
    const server = await startCodeGraphServer(projectPath, {
      hostname: options.host || '127.0.0.1',
      port,
      projects: additionalProjects,
    });

    console.log(`Cheshi CodeGraph server: ${server.url}`);
    console.log('Press Ctrl-C to stop the server.');

    let stopping = false;
    await new Promise<void>((resolve) => {
      const stop = () => {
        if (stopping) return;
        stopping = true;
        server.close();
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } catch (error) {
    console.error(`Failed to start CodeGraph server: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});

await program.parseAsync();
