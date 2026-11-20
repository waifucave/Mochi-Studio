import type { JsonSchema } from './schema';
import { CommandRegistry, type CommandInfo } from './registry';
import { studioCommands, type StudioApi } from './studioCommands';

/** The command catalog, without an app (for the bridge's static copy and the docs). */
export function commandCatalog(): CommandInfo[] {
  return new CommandRegistry<StudioApi>({} as StudioApi, studioCommands()).catalog();
}

function argSummary(schema: JsonSchema): string {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const names = Object.keys(props).map((k) => (required.has(k) ? `\`${k}\`` : `\`${k}?\``));
  return names.length ? names.join(', ') : '';
}

/** A Markdown table of every command, for docs/agent-api.md. */
export function commandTable(): string {
  const rows = commandCatalog().map(
    (c) =>
      `| \`${c.name}\` | ${c.scope} | ${argSummary(c.inputSchema)} | ${c.summary}${c.undoable ? ' Undoable.' : ''} |`,
  );
  return [
    '| Command | Scope | Arguments | What it does |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** The table as Prettier formats it (Node only: for the generator and the test). */
export async function formattedCommandTable(): Promise<string> {
  const { format } = await import('prettier');
  return (await format(commandTable(), { parser: 'markdown', proseWrap: 'preserve' })).trimEnd();
}
