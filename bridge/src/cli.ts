/**
 * mochi-studio-bridge: the local bridge between Mochi Studio and agents.
 *
 *   mochi-studio-bridge [serve] [--port N] [--allow-origin URL]...
 *   mochi-studio-bridge mcp [--port N]
 *   mochi-studio-bridge token create --name NAME [--scopes read,control,screenshot]
 *   mochi-studio-bridge token list
 *   mochi-studio-bridge token revoke ID
 *   mochi-studio-bridge status [--port N]
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, type ScopeName } from '../../src/core/bridgeProtocol.ts';
import { runMcp, staticCatalog } from './mcp.ts';
import { BRIDGE_VERSION, BridgeServer } from './server.ts';
import { BridgeStore, configDir, parseScopes } from './store.ts';

const HELP = `mochi-studio-bridge ${BRIDGE_VERSION}: the local bridge between Mochi Studio and agents.

Usage:
  mochi-studio-bridge [serve] [--port N] [--allow-origin URL]...
      Runs the bridge on 127.0.0.1 (default port ${DEFAULT_PORT}). Pages on
      http(s)://localhost and 127.0.0.1 may connect; add others (for example
      where you host Mochi Studio) with --allow-origin.
  mochi-studio-bridge mcp [--port N]
      An MCP server over stdio, for MCP clients. Needs MOCHI_STUDIO_TOKEN.
      Starts the bridge too when none runs.
  mochi-studio-bridge token create --name NAME [--scopes read,control,screenshot]
  mochi-studio-bridge token list
  mochi-studio-bridge token revoke ID
  mochi-studio-bridge status [--port N]
      Whether the bridge runs, whether Mochi Studio is connected, and the
      pairing code.

Tokens and pairings are kept (hashed) in ${configDir()}.
`;

function option(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
}
function options(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1]) out.push(args[i + 1]!);
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  });
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = 'serve', ...rest] = argv;
  const portArg = option(argv, 'port');
  const port = portArg ? Number(portArg) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('--port must be a port number.\n');
    return 2;
  }
  switch (cmd) {
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case '--version':
      process.stdout.write(`${BRIDGE_VERSION}\n`);
      return 0;
    case 'serve':
    case '--port':
    case '--allow-origin': {
      // The phone tracker serves its page from the built pages (npm run build), when there.
      const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
      const server = new BridgeServer({
        port,
        allowOrigins: options(argv, 'allow-origin'),
        catalog: staticCatalog(),
        ...(existsSync(join(dist, 'phone.html')) ? { phone: { staticDir: dist } } : {}),
      });
      await server.listen();
      const stop = (): void => void server.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return await new Promise<number>(() => undefined);
    }
    case 'mcp':
      await runMcp({ port });
      return await new Promise<number>(() => undefined);
    case 'token': {
      const store = new BridgeStore();
      const sub = rest[0];
      if (sub === 'create') {
        const name = option(rest, 'name') ?? 'agent';
        const scopes = parseScopes(
          (option(rest, 'scopes') ?? 'read,control,screenshot').split(','),
        ) as ScopeName[];
        const { token, info } = store.createToken(name, scopes);
        process.stdout.write(`${token}\n`);
        process.stderr.write(
          `Token "${info.name}" (id ${info.id}, scopes ${info.scopes.join(', ')}). It is shown only now.\n`,
        );
        return 0;
      }
      if (sub === 'list') {
        for (const t of store.listTokens())
          process.stdout.write(
            `${t.id}  ${t.name}  ${t.scopes.join(',')}  created ${new Date(t.created).toISOString()}${t.lastUsed ? `  last used ${new Date(t.lastUsed).toISOString()}` : ''}\n`,
          );
        return 0;
      }
      if (sub === 'revoke' && rest[1]) {
        const ok = store.revokeToken(rest[1]);
        process.stderr.write(ok ? 'Revoked. Restart connected agents.\n' : 'No such token.\n');
        return ok ? 0 : 1;
      }
      process.stderr.write(HELP);
      return 2;
    }
    case 'status': {
      let info: { studio?: { connected: boolean } } | undefined;
      try {
        info = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as typeof info;
      } catch {
        info = undefined;
      }
      if (!info) process.stdout.write(`The bridge is not running on port ${port}.\n`);
      else {
        process.stdout.write(
          `The bridge runs on port ${port}. Mochi Studio is ${info.studio?.connected ? '' : 'not '}connected.\n`,
        );
        const p = BridgeStore.readPairing();
        if (p)
          process.stdout.write(
            `Pairing code: ${p.code} (valid until ${new Date(p.expires).toLocaleTimeString()}).\n`,
          );
      }
      return 0;
    }
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}
