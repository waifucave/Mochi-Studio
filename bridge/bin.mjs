#!/usr/bin/env node
// mochi-studio-bridge. The bridge is TypeScript that Node runs directly
// (type stripping, Node 22.18 or later).
import { main } from './src/cli.ts';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(1);
  },
);
