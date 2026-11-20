/**
 * Recent models in the desktop app: the folders and zips the person opened
 * with the app's dialogs, newest first, kept in the app's data folder
 * (`recent-models.json`). Only the main process reads and writes it; pages
 * get the list and may reopen only folders on it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const MAX_RECENT = 10;

export interface RecentModel {
  path: string;
  label: string;
  /** Milliseconds since 1970. */
  openedAt: number;
}

/** Whether a recent folder can be opened: there, moved or gone, or no longer a model. */
export type RecentState = 'ok' | 'missing' | 'no-model';

export interface RecentModelInfo extends RecentModel {
  state: RecentState;
}

/** Whether a folder holds a model settings file (at its top or one level down). */
function hasModel(dir: string): boolean {
  const names = readdirSync(dir);
  if (names.some((n) => n.toLowerCase().endsWith('.model3.json'))) return true;
  return names.some((n) => {
    const p = join(dir, n);
    try {
      return (
        !n.startsWith('.') &&
        statSync(p).isDirectory() &&
        readdirSync(p).some((m) => m.toLowerCase().endsWith('.model3.json'))
      );
    } catch {
      return false;
    }
  });
}

/** Whether a path is a zip (by its name). */
export const isZipPath = (path: string): boolean => /\.zip$/i.test(path);

export function recentState(path: string): RecentState {
  try {
    if (!existsSync(path)) return 'missing';
    // A zip is checked when it is opened (Mochi Studio reads it then).
    if (isZipPath(path)) return statSync(path).isFile() ? 'ok' : 'missing';
    if (!statSync(path).isDirectory()) return 'missing';
    return hasModel(path) ? 'ok' : 'no-model';
  } catch {
    return 'missing';
  }
}

export class RecentModels {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }

  private read(): RecentModel[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(
          (r): r is RecentModel =>
            !!r &&
            typeof r.path === 'string' &&
            typeof r.label === 'string' &&
            typeof r.openedAt === 'number',
        )
        .slice(0, MAX_RECENT);
    } catch {
      return [];
    }
  }

  private write(list: RecentModel[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(list, null, 2));
  }

  /** The list, newest first, with each folder's state now. */
  list(): RecentModelInfo[] {
    return this.read().map((r) => ({ ...r, state: recentState(r.path) }));
  }

  has(path: string): boolean {
    return this.read().some((r) => r.path === path);
  }

  /** Puts a folder first (opened now). */
  add(path: string, now = Date.now()): void {
    const rest = this.read().filter((r) => r.path !== path);
    this.write([{ path, label: basename(path), openedAt: now }, ...rest].slice(0, MAX_RECENT));
  }

  forget(path: string): void {
    this.write(this.read().filter((r) => r.path !== path));
  }
}
