/**
 * Each participant's state over a WebRTC data channel
 * (docs/collaboration.md, section 3).
 *
 * **Parameters**, binary, at the host's rate: 16 bits each, scaled to the
 * parameter's range, and only the ones that changed since the last frame
 * (a newly connected participant gets them all once). The indices refer to
 * the parameter table the sender announced with its model.
 *
 *     u8 kind = 1 · u32 sender time (ms, wraps) · u16 count · count × (u16 index, u16 value)
 *
 * **Smoothing** (`RemoteParams`): the receiver keeps the last second or two
 * of frames, timed by the sender's clock, and shows them a little late (the
 * smoothing delay), interpolating between the two frames around that time.
 * Parameters the model marks as never smoothed
 * (`ParametersExcludedFromVNetSmoothing`) take the last value
 * instead.
 */

export const PARAMS_KIND = 1;
export const MAX_Q = 65535;

export interface ParamInfo {
  id: string;
  min: number;
  max: number;
}

export function quantize(v: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const q = Math.round(((v - min) / (max - min)) * MAX_Q);
  return q < 0 ? 0 : q > MAX_Q ? MAX_Q : q;
}

export function dequantize(q: number, min: number, max: number): number {
  return max > min ? min + (q / MAX_Q) * (max - min) : min;
}

export function encodeParams(time: number, entries: [index: number, q: number][]): Uint8Array {
  const b = new Uint8Array(7 + entries.length * 4);
  const d = new DataView(b.buffer);
  d.setUint8(0, PARAMS_KIND);
  d.setUint32(1, time >>> 0);
  d.setUint16(5, entries.length);
  let o = 7;
  for (const [i, q] of entries) {
    d.setUint16(o, i);
    d.setUint16(o + 2, q);
    o += 4;
  }
  return b;
}

export function decodeParams(
  b: Uint8Array,
): { time: number; entries: [number, number][] } | undefined {
  if (b.length < 7 || b[0] !== PARAMS_KIND) return undefined;
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = d.getUint16(5);
  if (b.length !== 7 + n * 4) return undefined;
  const entries: [number, number][] = [];
  for (let k = 0, o = 7; k < n; k++, o += 4) entries.push([d.getUint16(o), d.getUint16(o + 2)]);
  return { time: d.getUint32(1), entries };
}

/** The sender's side: what changed since the last frame. */
export class ParamSender {
  private last: Int32Array;
  readonly table: ParamInfo[];
  private index: Map<string, number>;

  constructor(table: ParamInfo[]) {
    this.table = table;
    this.last = new Int32Array(table.length).fill(-1);
    this.index = new Map(table.map((p, i) => [p.id, i]));
  }

  /** The entries that changed (all of them with `full`), and remembers them. */
  frame(values: Readonly<Record<string, number>>, full = false): [number, number][] {
    const out: [number, number][] = [];
    for (const [id, v] of Object.entries(values)) {
      const i = this.index.get(id);
      if (i === undefined || !Number.isFinite(v)) continue;
      const p = this.table[i]!;
      const q = quantize(v, p.min, p.max);
      if (full || q !== this.last[i]) out.push([i, q]);
      this.last[i] = q;
    }
    if (full)
      for (let i = 0; i < this.last.length; i++)
        if (this.last[i]! >= 0 && !out.some(([j]) => j === i)) out.push([i, this.last[i]!]);
    return out;
  }
}

interface Snapshot {
  /** When to show it, on the receiver's clock. */
  at: number;
  q: Int32Array;
}

/** The receiver's side: frames in, smoothed values out. */
export class RemoteParams {
  readonly table: ParamInfo[];
  private excluded: Uint8Array;
  private frames: Snapshot[] = [];
  private current: Int32Array;
  /** Receiver time minus sender time, the smallest seen lately (the fastest delivery). */
  private offset = Infinity;
  private offsetSeenAt = 0;
  private lastSenderTime: number | undefined;
  private unwrap = 0;

  constructor(table: ParamInfo[], neverSmoothed: Iterable<string> = []) {
    this.table = table;
    this.current = new Int32Array(table.length).fill(-1);
    const ex = new Set(neverSmoothed);
    this.excluded = Uint8Array.from(table, (p) => (ex.has(p.id) ? 1 : 0));
  }

  /** A frame arrived at `now` (receiver ms). */
  push(senderTime: number, now: number, entries: Iterable<[number, number]>): void {
    // The sender's clock wraps at 2³²; keep it rising.
    if (this.lastSenderTime !== undefined && senderTime < this.lastSenderTime - 2 ** 31)
      this.unwrap += 2 ** 32;
    this.lastSenderTime = senderTime;
    const t = senderTime + this.unwrap;
    // The fastest delivery of the last 10 s sets the offset (jitter only ever adds delay).
    const o = now - t;
    if (o < this.offset || now - this.offsetSeenAt > 10_000) {
      this.offset = o;
      this.offsetSeenAt = now;
    }
    for (const [i, q] of entries) if (i < this.current.length) this.current[i] = q;
    this.frames.push({ at: t + this.offset, q: this.current.slice() });
    // Two seconds are enough for a delay of up to one.
    const keepFrom = now - 2000;
    while (this.frames.length > 2 && this.frames[1]!.at < keepFrom) this.frames.shift();
  }

  /** Values to show at `now`, `delayMs` late; parameters never received are left out. */
  sample(now: number, delayMs: number): Record<string, number> {
    const out: Record<string, number> = {};
    const f = this.frames;
    if (!f.length) return out;
    const t = now - delayMs;
    let k = f.length - 1;
    while (k > 0 && f[k]!.at > t) k--;
    const a = f[k]!;
    const b = f[k + 1];
    const w = b && b.at > a.at ? Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))) : 0;
    for (let i = 0; i < this.table.length; i++) {
      const qa = a.q[i]!;
      if (qa < 0) continue;
      const p = this.table[i]!;
      const qb = b?.q[i] ?? qa;
      const q = this.excluded[i] || !b || qb < 0 ? qa : qa + (qb - qa) * w;
      out[p.id] = dequantize(q, p.min, p.max);
    }
    return out;
  }

  /** The latest values, unsmoothed. */
  latest(): Record<string, number> {
    const out: Record<string, number> = {};
    this.table.forEach((p, i) => {
      const q = this.current[i]!;
      if (q >= 0) out[p.id] = dequantize(q, p.min, p.max);
    });
    return out;
  }
}
