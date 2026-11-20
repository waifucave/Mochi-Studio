/**
 * Writes the command catalog that the bridge ships (bridge/catalog.json),
 * and the command table of docs/agent-api.md, from the command registry.
 * A unit test checks both are up to date: run `npm run agent:catalog`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { format } from 'prettier';
import { commandCatalog, formattedCommandTable } from '../src/core/commands/catalog';

const root = new URL('..', import.meta.url);
writeFileSync(
  new URL('bridge/catalog.json', root),
  await format(JSON.stringify(commandCatalog()), { parser: 'json' }),
);
const docUrl = new URL('docs/agent-api.md', root);
const doc = readFileSync(docUrl, 'utf8');
const start = '<!-- commands:start -->';
const end = '<!-- commands:end -->';
const i = doc.indexOf(start);
const j = doc.indexOf(end);
if (i < 0 || j < 0) throw new Error('docs/agent-api.md has no command markers');
const table = await formattedCommandTable();
writeFileSync(docUrl, doc.slice(0, i + start.length) + '\n\n' + table + '\n\n' + doc.slice(j));
console.log('Wrote bridge/catalog.json and the command table of docs/agent-api.md.');
