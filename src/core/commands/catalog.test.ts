import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandCatalog, formattedCommandTable } from './catalog';

describe('the published catalog', () => {
  it('bridge/catalog.json and docs/agent-api.md match the registry (run npm run agent:catalog)', async () => {
    const shipped = JSON.parse(
      readFileSync(new URL('../../../bridge/catalog.json', import.meta.url), 'utf8'),
    );
    expect(shipped).toEqual(JSON.parse(JSON.stringify(commandCatalog())));
    const doc = readFileSync(new URL('../../../docs/agent-api.md', import.meta.url), 'utf8');
    expect(doc).toContain(await formattedCommandTable());
  });
});
