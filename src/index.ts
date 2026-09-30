#!/usr/bin/env node
import { main } from './cli/main.ts';

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`forge: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
