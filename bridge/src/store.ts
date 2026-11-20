/**
 * The bridge's local state: client tokens, host tokens (paired pages) and
 * the current pairing code. Only SHA-256 hashes of tokens are kept. The
 * files live in the config folder, readable by the user only.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScopeName, TokenInfo } from '../../src/core/bridgeProtocol.ts';

const SCOPES: readonly ScopeName[] = ['read', 'control', 'screenshot'];

interface StoredToken extends TokenInfo {
  hash: string;
}
interface StoreFile {
  version: 1;
  tokens: StoredToken[];
  hosts: Array<{ id: string; hash: string; created: number; lastUsed: number | null }>;
  /** The output views' key (one at a time), hashed. */
  view?: { hash: string; created: number };
}

export function configDir(): string {
  const env = process.env.MOCHI_STUDIO_BRIDGE_HOME;
  if (env) return env;
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'mochi-studio-bridge');
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const sameHash = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newToken = (prefix: string): string => `${prefix}_${randomBytes(24).toString('base64url')}`;
const newId = (): string => randomBytes(6).toString('hex');

export function parseScopes(list: unknown): ScopeName[] {
  if (!Array.isArray(list)) return [];
  return SCOPES.filter((s) => list.includes(s));
}

export class BridgeStore {
  private file: string;
  private pairingFile: string;
  private data: StoreFile;
  private pairing: { code: string; expires: number; attempts: number } | undefined;

  private dir: string;

  constructor(dir: string = configDir()) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'tokens.json');
    this.pairingFile = join(dir, 'pairing.json');
    this.data = this.load();
  }

  /** The folder the bridge keeps its files in. */
  get directory(): string {
    return this.dir;
  }

  private load(): StoreFile {
    if (!existsSync(this.file)) return { version: 1, tokens: [], hosts: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreFile>;
      return {
        version: 1,
        tokens: Array.isArray(raw.tokens)
          ? raw.tokens.map((t) => ({ ...t, scopes: parseScopes(t.scopes) }))
          : [],
        hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
        ...(raw.view && typeof raw.view.hash === 'string' ? { view: raw.view } : {}),
      };
    } catch {
      return { version: 1, tokens: [], hosts: [] };
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* not supported on this file system */
    }
  }

  // --- client tokens ---------------------------------------------------------

  createToken(name: string, scopes: ScopeName[]): { token: string; info: TokenInfo } {
    this.data = this.load();
    const token = newToken('mst');
    const info: TokenInfo = {
      id: newId(),
      name: name.slice(0, 60) || 'agent',
      scopes: parseScopes(scopes),
      created: Date.now(),
      lastUsed: null,
    };
    this.data.tokens.push({ ...info, hash: hash(token) });
    this.save();
    return { token, info };
  }

  listTokens(): TokenInfo[] {
    this.data = this.load();
    return this.data.tokens.map(({ hash: _h, ...t }) => t);
  }

  revokeToken(id: string): boolean {
    this.data = this.load();
    const n = this.data.tokens.length;
    this.data.tokens = this.data.tokens.filter((t) => t.id !== id);
    if (this.data.tokens.length === n) return false;
    this.save();
    return true;
  }

  /** The token's info, or undefined when it is unknown. */
  verifyToken(token: unknown): TokenInfo | undefined {
    if (typeof token !== 'string' || !token.startsWith('mst_')) return undefined;
    // Tokens may have been created by another process (the command line).
    this.data = this.load();
    const h = hash(token);
    const t = this.data.tokens.find((x) => sameHash(x.hash, h));
    if (!t) return undefined;
    t.lastUsed = Date.now();
    this.save();
    const { hash: _h, ...info } = t;
    return info;
  }

  // --- output views ------------------------------------------------------------

  /** A new key for output views; the previous one stops working. */
  newViewKey(): string {
    this.data = this.load();
    const key = newToken('msv');
    this.data.view = { hash: hash(key), created: Date.now() };
    this.save();
    return key;
  }

  hasViewKey(): boolean {
    this.data = this.load();
    return !!this.data.view;
  }

  verifyViewKey(key: unknown): boolean {
    if (typeof key !== 'string' || !key.startsWith('msv_')) return false;
    const v = this.data.view ?? this.load().view;
    return !!v && sameHash(v.hash, hash(key));
  }

  // --- the host (the page) -----------------------------------------------------

  verifyHostToken(token: unknown): boolean {
    if (typeof token !== 'string' || !token.startsWith('msh_')) return false;
    const h = hash(token);
    const host = this.data.hosts.find((x) => sameHash(x.hash, h));
    if (!host) return false;
    host.lastUsed = Date.now();
    this.save();
    return true;
  }

  /** The current pairing code, making a new one when there is none or it expired. */
  pairingCode(): string {
    if (!this.pairing || this.pairing.expires < Date.now()) {
      this.pairing = {
        code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        expires: Date.now() + 10 * 60_000,
        attempts: 0,
      };
      writeFileSync(
        this.pairingFile,
        JSON.stringify({ code: this.pairing.code, expires: this.pairing.expires }),
        {
          mode: 0o600,
        },
      );
    }
    return this.pairing.code;
  }

  /** Checks a pairing code. On success, returns a new host token; the code is used up. */
  pair(code: unknown): string | undefined {
    const p = this.pairing;
    if (!p || p.expires < Date.now()) return undefined;
    if (typeof code !== 'string' || code.trim() !== p.code) {
      // Five wrong tries make a new code.
      if (++p.attempts >= 5) this.pairing = undefined;
      return undefined;
    }
    this.pairing = undefined;
    const token = newToken('msh');
    this.data.hosts.push({
      id: newId(),
      hash: hash(token),
      created: Date.now(),
      lastUsed: Date.now(),
    });
    // Keep the ten most recent pairings.
    this.data.hosts = this.data.hosts.slice(-10);
    this.save();
    return token;
  }

  /** Reads the pairing code another bridge process wrote (for `mochi-studio-bridge status`). */
  static readPairing(dir: string = configDir()): { code: string; expires: number } | undefined {
    try {
      const p = JSON.parse(readFileSync(join(dir, 'pairing.json'), 'utf8')) as {
        code: string;
        expires: number;
      };
      return p.expires > Date.now() ? p : undefined;
    } catch {
      return undefined;
    }
  }
}
