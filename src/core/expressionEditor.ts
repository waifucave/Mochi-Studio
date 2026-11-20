/**
 * The expression editor: expressions
 * made or changed in Mochi Studio, as `.exp3.json` files.
 *
 * An expression ticks some of the model's parameters and gives each a value
 * and a mode:
 *
 * - **Overwrite**: the parameter takes the value (within its range);
 * - **Add**: the value is added to what the parameter has;
 * - **Multiply**: the parameter is multiplied by the value (1 changes nothing,
 *   −1 inverts a tracked value).
 *
 * Physics outputs cannot be used: physics overwrites them every frame.
 * Saving writes an `.exp3.json` (the same keys as the model's own files):
 * on the desktop into the model folder, in the browser into the model's
 * settings, with an export.
 */
import { parseExpression } from 'mochi2d/headless';
import type { Hotkey } from './hotkeys';

export type ExpressionBlend = 'Overwrite' | 'Add' | 'Multiply';
export const BLENDS: readonly ExpressionBlend[] = ['Overwrite', 'Add', 'Multiply'];

export interface DraftParameter {
  id: string;
  value: number;
  blend: ExpressionBlend;
}

/** An expression being edited. */
export interface ExpressionDraft {
  name: string;
  /** Seconds. */
  fadeIn: number;
  fadeOut: number;
  parameters: DraftParameter[];
}

/** The fade times of a new expression (seconds). */
export const DEFAULT_FADE = 0.5;
export const MAX_FADE = 10;
/** The largest multiplier (and the most negative one, negated). */
export const MAX_FACTOR = 10;
/** The largest `.exp3.json` kept in the settings. */
export const MAX_EXPRESSION_BYTES = 256 * 1024;

/** An expression made or changed in the editor, as the model's settings keep it. */
export interface OwnExpression {
  /** The file, relative to the model folder: a new one, or one of the model's that was changed. */
  file: string;
  name: string;
  /**
   * The file's text. Kept in the settings in the browser; on the desktop the
   * file in the model folder is the expression, and this is left out.
   */
  json?: string;
}

export function newDraft(name = ''): ExpressionDraft {
  return { name, fadeIn: DEFAULT_FADE, fadeOut: DEFAULT_FADE, parameters: [] };
}

const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;

/** The `.exp3.json` text of a draft (parameters in the order given). */
export function expressionFileText(d: ExpressionDraft): string {
  return `${JSON.stringify(
    {
      FadeInTime: round(clampFade(d.fadeIn)),
      FadeOutTime: round(clampFade(d.fadeOut)),
      Parameters: d.parameters.map((p) => ({ Id: p.id, Value: round(p.value), Blend: p.blend })),
    },
    null,
    2,
  )}\n`;
}

/** A draft from an `.exp3.json` file (read with Mochi2D's parser); throws on a broken file. */
export function draftFromFile(name: string, bytes: Uint8Array | string): ExpressionDraft {
  const e = parseExpression(bytes, name);
  return {
    name,
    fadeIn: clampFade(e.fadeIn),
    fadeOut: clampFade(e.fadeOut),
    parameters: e.parameters.map((p) => ({ id: p.id, value: p.value, blend: p.blend })),
  };
}

export const clampFade = (s: number): number =>
  Number.isFinite(s) ? Math.max(0, Math.min(MAX_FADE, s)) : DEFAULT_FADE;

/**
 * Limits a value to what makes sense for its mode: within the parameter's
 * range for Overwrite, within ±(max − min) for Add, ±`MAX_FACTOR` for Multiply.
 */
export function clampDraftValue(
  blend: ExpressionBlend,
  v: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(v)) return startValue(blend, min, min, max);
  const span = Math.abs(max - min);
  const [lo, hi] =
    blend === 'Overwrite'
      ? [Math.min(min, max), Math.max(min, max)]
      : blend === 'Add'
        ? [-span, span]
        : [-MAX_FACTOR, MAX_FACTOR];
  return Math.max(lo, Math.min(hi, v));
}

/** A parameter's value when it is ticked, or its mode changes: what changes nothing yet. */
export function startValue(
  blend: ExpressionBlend,
  current: number,
  min: number,
  max: number,
): number {
  if (blend === 'Add') return 0;
  if (blend === 'Multiply') return 1;
  return Math.max(Math.min(min, max), Math.min(Math.max(min, max), current));
}

/** Physics outputs among a draft's parameters: physics overwrites them, so they would not show. */
export function physicsConflicts(
  d: ExpressionDraft,
  physicsOutputs: ReadonlySet<string>,
): string[] {
  return d.parameters.filter((p) => physicsOutputs.has(p.id)).map((p) => p.id);
}

/** A name made safe as a file name (letters, digits, spaces, `-`, `_`, `.`). */
export function safeFileStem(name: string): string {
  const s = name
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\.exp3\.json$/i, '')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
  return s || 'Expression';
}

/**
 * The file for a new expression: in the folder the model's expressions share
 * (as the familiar editor does), or the model folder; never one already taken.
 */
export function newExpressionFile(
  name: string,
  existing: readonly string[],
  taken: ReadonlySet<string>,
): string {
  const dirs = new Set(
    existing.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')),
  );
  const dir = dirs.size === 1 ? [...dirs][0]! : '';
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  const stem = safeFileStem(name);
  for (let i = 1; ; i++) {
    const file = `${dir ? `${dir}/` : ''}${stem}${i > 1 ? ` ${i}` : ''}.exp3.json`;
    if (!lower.has(file.toLowerCase())) return file;
  }
}

/** Whether a stored file path is acceptable: relative, inside the folder, an `.exp3.json`. */
export function validExpressionFile(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    file.length <= 300 &&
    /\.exp3\.json$/i.test(file) &&
    !file.startsWith('/') &&
    !/^[a-z]:/i.test(file) &&
    !file.split('/').some((s) => s === '..' || s === '' || s === '.')
  );
}

/** Validates the stored list (invalid entries dropped, one entry per file). */
export function parseOwnExpressions(raw: unknown): OwnExpression[] {
  if (!Array.isArray(raw)) return [];
  const out: OwnExpression[] = [];
  const seen = new Set<string>();
  for (const v of raw.slice(0, 500)) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (!validExpressionFile(o.file) || seen.has(o.file.toLowerCase())) continue;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 100) : '';
    const json =
      typeof o.json === 'string' && o.json.length <= MAX_EXPRESSION_BYTES ? o.json : undefined;
    seen.add(o.file.toLowerCase());
    out.push({
      file: o.file,
      name: name || safeFileStem(o.file.split('/').pop()!),
      ...(json !== undefined ? { json } : {}),
    });
  }
  return out;
}

/** The model's expressions (by name) that no hotkey toggles. */
export function expressionsWithoutHotkey(
  expressions: ReadonlyArray<{ name: string }>,
  hotkeys: readonly Hotkey[],
): string[] {
  const bound = new Set(
    hotkeys.flatMap((h) => (h.action.type === 'expression' ? [h.action.expression] : [])),
  );
  return expressions.map((e) => e.name).filter((n) => !bound.has(n));
}

/** New hotkeys (no keys yet, no on-screen button) for expressions that lack one. */
export function hotkeysForExpressions(
  names: readonly string[],
  taken: ReadonlySet<string>,
): Hotkey[] {
  const ids = new Set(taken);
  return names.map((name) => {
    let n = ids.size + 1;
    while (ids.has(`h${n}`)) n++;
    const id = `h${n}`;
    ids.add(id);
    return {
      id,
      label: name,
      keys: '',
      button: false,
      action: { type: 'expression', expression: name },
    };
  });
}
