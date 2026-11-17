#!/usr/bin/env node
/** Entrypoint publicado (`bin.adk`). Toda a lógica está em `runCli`. */

import { runCli } from './cli.js';

const { exitCode } = await runCli(process.argv.slice(2), { stream: true });
process.exit(exitCode);
