/**
 * Art-mesh geometry for the plugin API's beta events: points tracked on a mesh (`ArtMeshTrackingEvent`), and a
 * mesh's outline (`ArtMeshOutlineEvent`). Pure: positions come in as
 * functions of a vertex index, in whatever coordinates the caller uses.
 */

export type Point = { x: number; y: number };

/**
 * A triangle mesh's outline: its boundary edges (those of one triangle only),
 * chained into rings, one per connected piece (and per hole).
 */
export function boundaryLoops(triangles: ArrayLike<number>): number[][] {
  const count = new Map<string, { a: number; b: number; n: number }>();
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const tri = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
    for (let k = 0; k < 3; k++) {
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const e = count.get(key);
      if (e) e.n++;
      else count.set(key, { a, b, n: 1 });
    }
  }
  // Boundary edges, as directed in their triangle, from each start vertex.
  const out = new Map<number, number[]>();
  for (const e of count.values())
    if (e.n === 1) {
      const list = out.get(e.a);
      if (list) list.push(e.b);
      else out.set(e.a, [e.b]);
    }
  const loops: number[][] = [];
  for (const start of [...out.keys()].sort((x, y) => x - y)) {
    while (out.get(start)?.length) {
      const loop = [start];
      let v = start;
      for (;;) {
        const next = out.get(v)?.shift();
        if (next === undefined || next === start) break;
        loop.push(next);
        v = next;
        if (loop.length > triangles.length) break; // a broken mesh: stop
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** A point on a ring: `t` of the way along the edge from vertex `a` to vertex `b`. */
export interface EdgePoint {
  a: number;
  b: number;
  t: number;
}

/** `n` points evenly spaced along a closed ring (by length, at `pos`), as edge points. */
export function resampleLoop(
  loop: readonly number[],
  pos: (v: number) => Point,
  n: number,
): EdgePoint[] {
  const lens = loop.map((v, i) => {
    const p = pos(v);
    const q = pos(loop[(i + 1) % loop.length]!);
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
  const total = lens.reduce((a, b) => a + b, 0);
  const out: EdgePoint[] = [];
  let edge = 0;
  let start = 0; // length before this edge
  for (let k = 0; k < n; k++) {
    const want = total > 0 ? (k * total) / n : 0;
    while (edge < loop.length - 1 && start + lens[edge]! < want) start += lens[edge++]!;
    const len = lens[edge]!;
    out.push({
      a: loop[edge]!,
      b: loop[(edge + 1) % loop.length]!,
      t: len > 0 ? Math.min(1, Math.max(0, (want - start) / len)) : 0,
    });
  }
  return out;
}

export const atEdge = (p: EdgePoint, pos: (v: number) => Point): Point => {
  const a = pos(p.a);
  const b = pos(p.b);
  return { x: a.x + (b.x - a.x) * p.t, y: a.y + (b.y - a.y) * p.t };
};

/** A polygon's area (the shoelace formula), positive either way round. */
export function ringArea(points: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

/** A tracked point: barycentric weights on a triangle (three equal vertices: one vertex). */
export interface TrackedPoint {
  vertices: readonly [number, number, number];
  weights: readonly [number, number, number];
}

export function pointOn(p: TrackedPoint, pos: (v: number) => Point): Point {
  let x = 0;
  let y = 0;
  for (let k = 0; k < 3; k++) {
    const q = pos(p.vertices[k]!);
    x += q.x * p.weights[k]!;
    y += q.y * p.weights[k]!;
  }
  return { x, y };
}

/**
 * How the point's triangle is turned and scaled now against a reference
 * pose: its first edge's angle (degrees, counterclockwise with y up) and
 * length. A single vertex has neither.
 */
export function triangleFrame(
  p: TrackedPoint,
  pos: (v: number) => Point,
): { angle: number; length: number } | undefined {
  const [v1, v2, v3] = p.vertices;
  const b = v2 !== v1 ? v2 : v3;
  if (b === v1) return undefined;
  const a = pos(v1);
  const c = pos(b);
  const length = Math.hypot(c.x - a.x, c.y - a.y);
  return length > 0
    ? { angle: (Math.atan2(c.y - a.y, c.x - a.x) * 180) / Math.PI, length }
    : undefined;
}
