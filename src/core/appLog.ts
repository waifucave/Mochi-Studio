/**
 * The app's log: what the person sees in the Log sheet
 * and can save for a bug report.
 *
 * - Errors never stop the stage: the frame's steps run guarded (`guard`),
 *   and what fails is logged here instead.
 * - A message that repeats (an error every frame) is one entry with a count.
 * - Nothing personal goes in: every message is scrubbed first (`scrub`):
 *   picture and file data, home folder names, e-mail addresses, network
 *   addresses, long tokens and the query part of addresses (view keys).
 *   The camera picture never reaches the log: only text does.
 */

export type LogKind = 'info' | 'error';

export interface LogEntry {
  /** Milliseconds since 1970 (Date.now()). */
  time: number;
  kind: LogKind;
  text: string;
  /** How many times it came, in a row. */
  count: number;
  /** The last time it came. */
  last: number;
}

/** Entries kept (the oldest go first). */
export const LOG_LIMIT = 500;
/** A message is folded into the previous entry when it repeats within this time. */
const REPEAT_MS = 60_000;
/** How many recent entries a repeat is looked for in. */
const FOLD_BACK = 20;
/** The longest message kept. */
const MAX_TEXT = 2000;

/** Removes what could be personal from a message (see the module comment). */
export function scrub(text: string): string {
  let t = String(text);
  // Picture or file data: data URLs and long base64 runs.
  t = t.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, '[data]');
  t = t.replace(/[A-Za-z0-9+/]{120,}={0,2}/g, '[data]');
  // Addresses: keep the scheme, host and path, drop the query and fragment (view keys, tokens).
  t = t.replace(/\b((?:https?|wss?|file):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1?…');
  // Home folders: the user name.
  t = t.replace(/(\/(?:Users|home)\/)[^/\s"'<>]+/g, '$1…');
  // (Windows user names may have spaces; macOS and Linux short names have none.)
  t = t.replace(/([A-Za-z]:\\(?:Users|Documents and Settings)\\)[^\\"'<>\n]+/gi, '$1…');
  // E-mail addresses.
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[e-mail]');
  // Network addresses, except this computer's own.
  t = t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) =>
    ip.startsWith('127.') || ip === '0.0.0.0' ? ip : '[address]',
  );
  // Long tokens and keys: letters and digits mixed, 24 or more.
  t = t.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, '[id]');
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

/** An error's message, from anything thrown. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

export class AppLog {
  readonly entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry, isNew: boolean) => void>();

  constructor(private now: () => number = () => Date.now()) {}

  /** Adds a message; returns whether it is new (not a repeat of the last entry). */
  add(text: string, kind: LogKind = 'info'): boolean {
    const clean = scrub(text);
    const t = this.now();
    // A repeat of a recent entry (errors of two steps every frame interleave) is folded into it.
    for (let i = this.entries.length - 1; i >= Math.max(0, this.entries.length - FOLD_BACK); i--) {
      const e = this.entries[i]!;
      if (e.text === clean && e.kind === kind && t - e.last < REPEAT_MS) {
        e.count++;
        e.last = t;
        for (const l of this.listeners) l(e, false);
        return false;
      }
    }
    const e: LogEntry = { time: t, kind, text: clean, count: 1, last: t };
    this.entries.push(e);
    if (this.entries.length > LOG_LIMIT) this.entries.splice(0, this.entries.length - LOG_LIMIT);
    for (const l of this.listeners) l(e, true);
    return true;
  }

  error(where: string, e: unknown): boolean {
    return this.add(`${where}: ${errorText(e)}`, 'error');
  }

  clear(): void {
    this.entries.length = 0;
  }

  on(fn: (e: LogEntry, isNew: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The entries as text lines, oldest first. */
  lines(): string[] {
    return this.entries.map(
      (e) =>
        `${new Date(e.time).toISOString()} ${e.kind}${e.count > 1 ? ` (×${e.count})` : ''} ${e.text}`,
    );
  }
}

/**
 * Runs one step of a frame; an error is logged (once while it repeats) and
 * the frame goes on. Returns the step's value, or undefined if it failed.
 */
export function guard<T>(
  log: (where: string, e: unknown) => void,
  where: string,
  fn: () => T,
): T | undefined {
  try {
    return fn();
  } catch (e) {
    log(where, e);
    return undefined;
  }
}

export interface ReportInfo {
  version: string;
  userAgent: string;
  desktop: boolean;
  /** Short facts without personal data: counts and switches. */
  facts: Record<string, string | number | boolean>;
}

/** A bug report: the app and browser, a few facts, and the log. Everything is scrubbed. */
export function bugReport(log: AppLog, info: ReportInfo): string {
  const facts = Object.entries(info.facts).map(([k, v]) => `${k}: ${scrub(String(v))}`);
  return [
    'Mochi Studio log',
    `Saved: ${new Date().toISOString()}`,
    `Version: ${scrub(info.version)}`,
    `App: ${info.desktop ? 'desktop' : 'browser'}`,
    `Browser: ${scrub(info.userAgent)}`,
    ...facts,
    '',
    'No camera pictures, files, names or addresses are included; check before sending.',
    '',
    ...log.lines(),
    '',
  ].join('\n');
}
