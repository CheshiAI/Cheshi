#!/usr/bin/env bun

import { configureCheshiCodeGraphEnvironment } from './cheshi-environment';

configureCheshiCodeGraphEnvironment();

await import('./codegraph');
