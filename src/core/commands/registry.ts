/**
 * The command layer: every user action is a typed, validated command, used
 * by the UI and by agents (through the local bridge) alike. Commands are
 * logged, can be replayed, and those that change settings or toggles can
 * be undone.
 */
import { Emitter } from '../events';
import { SchemaError, type JsonSchema, type Schema } from './schema';

/** Permission scopes of the agent API. */
export type Scope = 'read' | 'control' | 'screenshot';
export const SCOPES: readonly Scope[] = ['read', 'control', 'screenshot'];

/** Who sent a command. The UI holds every scope. */
export interface Origin {
  kind: 'ui' | 'agent' | 'replay';
  /** The agent's name (the token's name). */
  name?: string;
  scopes: readonly Scope[];
}
export const UI_ORIGIN: Origin = { kind: 'ui', scopes: SCOPES };

/** A failed command. `code` is stable; `message` says what to do about it. */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CommandDef<A, R, C> {
  name: string;
  /** One line: also the MCP tool description. */
  summary: string;
  /** More detail for the docs and the tool description. */
  details?: string;
  scope: Scope;
  args: Schema<A>;
  /**
   * Called before `run` for commands that can be undone: returns a function
   * that undoes the command (it captures the state it needs).
   */
  undo?(ctx: C, args: A): (() => void) | undefined;
  /** Leave out of logs and replays (reads, screenshots). */
  quiet?: boolean;
  run(ctx: C, args: A): Promise<R> | R;
}

/** Declares a command with its argument types inferred from the schema. */
export function command<A, R, C>(def: CommandDef<A, R, C>): CommandDef<unknown, unknown, C> {
  return def as unknown as CommandDef<unknown, unknown, C>;
}

export interface LogEntry {
  seq: number;
  /** Milliseconds since the epoch. */
  time: number;
  origin: { kind: Origin['kind']; name?: string };
  name: string;
  args: unknown;
  ok: boolean;
  error?: { code: string; message: string };
}

/** Published description of a command (catalog, MCP tools, docs). */
export interface CommandInfo {
  name: string;
  summary: string;
  details?: string;
  scope: Scope;
  undoable: boolean;
  readOnly: boolean;
  inputSchema: JsonSchema;
}

export type CommandEvents = {
  executed: { entry: LogEntry };
  history: { canUndo: boolean; canRedo: boolean };
};

const LOG_SIZE = 500;
/** Strings longer than this (audio, images) are left out of the log. */
const LOG_MAX_STRING = 2000;

/** The arguments as logged: long strings are replaced by a note, so the log stays small. */
function compactArgs(v: unknown): unknown {
  if (typeof v === 'string')
    return v.length > LOG_MAX_STRING ? { omitted: `a string of ${v.length} characters` } : v;
  if (Array.isArray(v)) return v.map(compactArgs);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compactArgs(x)]));
  return v;
}
const HISTORY_SIZE = 100;

export class CommandRegistry<C> {
  readonly events = new Emitter<CommandEvents>();
  private defs = new Map<string, CommandDef<unknown, unknown, C>>();
  private log: LogEntry[] = [];
  private seq = 0;
  private undoStack: Array<{ name: string; args: unknown; undo: () => void; origin: Origin }> = [];
  private redoStack: Array<{ name: string; args: unknown; origin: Origin }> = [];

  constructor(
    private ctx: C,
    defs: Array<CommandDef<unknown, unknown, C>> = [],
  ) {
    for (const d of defs) this.add(d);
  }

  add(def: CommandDef<unknown, unknown, C>): void {
    if (this.defs.has(def.name)) throw new Error(`Duplicate command ${def.name}`);
    this.defs.set(def.name, def);
  }

  get(name: string): CommandDef<unknown, unknown, C> | undefined {
    return this.defs.get(name);
  }

  catalog(): CommandInfo[] {
    return [...this.defs.values()].map((d) => ({
      name: d.name,
      summary: d.summary,
      ...(d.details ? { details: d.details } : {}),
      scope: d.scope,
      undoable: !!d.undo,
      readOnly: d.scope !== 'control',
      inputSchema: d.args.json,
    }));
  }

  /**
   * Validates and runs a command. Throws a `CommandError` (codes:
   * `unknown_command`, `invalid_arguments`, `forbidden`, or the command's
   * own) with a message that says what to do.
   */
  async dispatch(name: string, args?: unknown, origin: Origin = UI_ORIGIN): Promise<unknown> {
    const def = this.defs.get(name);
    if (!def)
      throw new CommandError(
        'unknown_command',
        `Unknown command "${name}". Call list_commands for the commands there are.`,
      );
    const refuse = (err: CommandError): never => {
      if (!def.quiet) this.record(name, args, origin, err);
      throw err;
    };
    if (!origin.scopes.includes(def.scope))
      refuse(
        new CommandError(
          'forbidden',
          `${name} needs the "${def.scope}" scope, which this connection does not have. Create a token with that scope in Mochi Studio (Agents tab).`,
        ),
      );
    let parsed: unknown;
    try {
      parsed = def.args.parse(args ?? {}, '');
    } catch (e) {
      if (e instanceof SchemaError)
        refuse(
          new CommandError('invalid_arguments', `Invalid arguments for ${name}: ${e.message}.`),
        );
      throw e;
    }
    const undo = def.undo?.(this.ctx, parsed);
    let result: unknown;
    try {
      result = await def.run(this.ctx, parsed);
    } catch (e) {
      const err =
        e instanceof CommandError
          ? e
          : new CommandError('failed', (e as Error)?.message ?? String(e));
      if (!def.quiet) this.record(name, parsed, origin, err);
      throw err;
    }
    if (!def.quiet) this.record(name, parsed, origin);
    if (undo && name !== 'undo' && name !== 'redo') {
      this.undoStack.push({ name, args: parsed, undo, origin });
      if (this.undoStack.length > HISTORY_SIZE) this.undoStack.shift();
      this.redoStack = [];
      this.emitHistory();
    }
    return result;
  }

  private record(name: string, args: unknown, origin: Origin, err?: CommandError): void {
    const entry: LogEntry = {
      seq: ++this.seq,
      time: Date.now(),
      origin: { kind: origin.kind, ...(origin.name ? { name: origin.name } : {}) },
      name,
      args: compactArgs(args),
      ok: !err,
      ...(err ? { error: { code: err.code, message: err.message } } : {}),
    };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    this.events.emit('executed', { entry });
  }

  private emitHistory(): void {
    this.events.emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Undoes the latest undoable command. Returns its name, or undefined. */
  undo(): string | undefined {
    const top = this.undoStack.pop();
    if (!top) return undefined;
    top.undo();
    this.redoStack.push({ name: top.name, args: top.args, origin: top.origin });
    this.emitHistory();
    return top.name;
  }

  /** Runs the latest undone command again. */
  async redo(): Promise<string | undefined> {
    const top = this.redoStack.pop();
    if (!top) return undefined;
    const keep = this.redoStack;
    await this.dispatch(top.name, top.args, top.origin);
    this.redoStack = keep;
    this.emitHistory();
    return top.name;
  }

  /** The latest log entries, oldest first. */
  entries(limit = LOG_SIZE): LogEntry[] {
    return this.log.slice(-limit);
  }

  /**
   * Runs logged commands again, in order. Only successful control commands
   * are replayed. With `keepTiming`, waits between them as they were
   * spaced (each wait capped at `maxWaitMs`).
   */
  async replay(
    entries: ReadonlyArray<
      Pick<LogEntry, 'name' | 'args'> & Partial<Pick<LogEntry, 'time' | 'ok'>>
    >,
    o: { keepTiming?: boolean; maxWaitMs?: number; origin?: Origin } = {},
  ): Promise<{ replayed: number; failed: Array<{ name: string; message: string }> }> {
    const origin = o.origin ?? { kind: 'replay', scopes: ['control'] };
    const failed: Array<{ name: string; message: string }> = [];
    let replayed = 0;
    let last: number | undefined;
    for (const e of entries) {
      const def = this.defs.get(e.name);
      if (e.ok === false || !def || def.scope !== 'control' || def.name === 'replay_log') continue;
      if (o.keepTiming && e.time !== undefined && last !== undefined) {
        const wait = Math.min(o.maxWaitMs ?? 5000, Math.max(0, e.time - last));
        if (wait) await new Promise((r) => setTimeout(r, wait));
      }
      if (e.time !== undefined) last = e.time;
      try {
        await this.dispatch(e.name, e.args, origin);
        replayed++;
      } catch (err) {
        failed.push({ name: e.name, message: (err as Error).message });
      }
    }
    return { replayed, failed };
  }
}
