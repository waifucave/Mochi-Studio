/**
 * The MCP server: `mochi-studio-bridge mcp`, started by an MCP client over
 * stdio. It joins the running bridge as a client (with the token in
 * MOCHI_STUDIO_TOKEN), or starts the bridge in this process when none runs.
 * Every Mochi Studio command the token's scopes allow is a tool; a
 * screenshot comes back as an image, so the agent sees the avatar.
 *
 * Results follow Mochi2D's own MCP server: JSON in `structuredContent` and in
 * a text item, `isError: true` with a message that says what to do.
 */
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_PORT, type CommandInfoWire } from '../../src/core/bridgeProtocol.ts';
import { BridgeClient, BridgeError } from './client.ts';
import { BRIDGE_VERSION, BridgeServer } from './server.ts';

/** The command catalog shipped with the bridge, for when Mochi Studio is not connected yet. */
export function staticCatalog(): CommandInfoWire[] {
  return JSON.parse(
    readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'),
  ) as CommandInfoWire[];
}

type ToolResult = {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const errorResult = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export function toolResult(name: string, result: unknown): ToolResult {
  if (name === 'screenshot' && result && typeof result === 'object' && 'data' in result) {
    const r = result as { data: string; mimeType: string };
    return {
      content: [
        { type: 'image', data: r.data, mimeType: r.mimeType },
        { type: 'text', text: 'The avatar as it is now (transparent background).' },
      ],
    };
  }
  const structured =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { result };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

export function toolList(catalog: CommandInfoWire[], scopes: readonly string[]) {
  return catalog
    .filter((c) => scopes.includes(c.scope))
    .map((c) => ({
      name: c.name,
      description: [
        c.summary,
        c.details,
        `Scope: ${c.scope}.${c.undoable ? ' Can be undone with undo.' : ''}`,
      ]
        .filter(Boolean)
        .join(' '),
      inputSchema: c.inputSchema as { type: 'object'; [k: string]: unknown },
      annotations: { readOnlyHint: c.readOnly, destructiveHint: false, openWorldHint: false },
    }));
}

export interface McpOptions {
  port?: number;
  token?: string;
}

export async function runMcp(o: McpOptions = {}): Promise<void> {
  const port = o.port ?? DEFAULT_PORT;
  const url = `ws://127.0.0.1:${port}/api`;
  const token = o.token ?? process.env.MOCHI_STUDIO_TOKEN ?? '';
  let client: BridgeClient | undefined;
  let startedHere: BridgeServer | undefined;
  let problem: string | undefined;

  const connect = async (): Promise<BridgeClient | undefined> => {
    if (client) return client;
    if (!token) {
      problem =
        'No token: set MOCHI_STUDIO_TOKEN in this MCP server’s environment. Create a token in Mochi Studio (Agents tab) or with "mochi-studio-bridge token create --name <name> --scopes read,control,screenshot".';
      return undefined;
    }
    try {
      client = await BridgeClient.connect(url, token, 'mcp');
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'unreachable' && !startedHere) {
        // No bridge runs: run it in this process.
        startedHere = new BridgeServer({ port, catalog: staticCatalog() });
        await startedHere.listen();
        client = await BridgeClient.connect(url, token, 'mcp').catch((e2: Error) => {
          problem = e2.message;
          return undefined;
        });
      } else problem = (e as Error).message;
    }
    if (client) {
      problem = undefined;
      client.onclose = () => (client = undefined);
    }
    return client;
  };

  const server = new Server(
    { name: 'mochi-studio', version: BRIDGE_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        'Controls the Mochi Studio live avatar: expressions, motions, items, parameters, background and placement, speech with lip sync, and screenshots. Start with get_state and describe_model; screenshot shows what the avatar looks like. Camera and microphone data are never available.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const c = await connect();
    const catalog = c?.welcome.commands.length ? c.welcome.commands : staticCatalog();
    return { tools: toolList(catalog, c?.welcome.scopes ?? ['read', 'control', 'screenshot']) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<ToolResult> => {
    const c = await connect();
    if (!c) return errorResult(problem ?? 'Cannot reach the bridge.');
    try {
      return toolResult(
        req.params.name,
        await c.command(req.params.name, req.params.arguments ?? {}),
      );
    } catch (e) {
      return errorResult((e as Error).message);
    }
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[mochi-studio-bridge] MCP server ready (bridge ${url}).\n`);
}
