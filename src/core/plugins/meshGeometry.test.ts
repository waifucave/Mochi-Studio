import { describe, expect, it } from 'vitest';
import {
  atEdge,
  boundaryLoops,
  pointOn,
  resampleLoop,
  ringArea,
  triangleFrame,
} from './meshGeometry';

// A 2 × 1 grid of squares (6 vertices), and a separate triangle (vertices 6–8).
//  0 — 1 — 2
//  |   |   |
//  3 — 4 — 5
const verts = [
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 5, y: 0 },
  { x: 6, y: 0 },
  { x: 5, y: 1 },
];
const pos = (v: number) => verts[v]!;
const tris = [0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 6, 7, 8];

describe('art-mesh geometry', () => {
  it('finds one boundary ring per connected piece', () => {
    const loops = boundaryLoops(tris);
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.length).sort()).toEqual([3, 6]);
    // The inner edges (1–4 and 1–3–4's diagonal) are not on the boundary.
    const big = loops.find((l) => l.length === 6)!;
    expect(new Set(big)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    const area = ringArea(big.map(pos));
    expect(area).toBeCloseTo(2);
  });

  it('spaces points evenly along a ring', () => {
    const big = boundaryLoops(tris).find((l) => l.length === 6)!;
    const pts = resampleLoop(big, pos, 20).map((p) => atEdge(p, pos));
    expect(pts).toHaveLength(20);
    // The ring is 6 long: a point every 0.3.
    for (let i = 0; i < 20; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % 20]!;
      const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      expect(d).toBeCloseTo(0.3, 5);
    }
  });

  it('tracks a point by its triangle, with its turn and scale', () => {
    const p = { vertices: [3, 5, 2] as const, weights: [0.25, 0.25, 0.5] as const };
    expect(pointOn(p, pos)).toEqual({ x: 1.5, y: 0.5 });
    expect(triangleFrame(p, pos)).toEqual({ angle: 0, length: 2 });
    // Turned by 90° and doubled.
    const turned = (v: number) => ({ x: -2 * pos(v).y, y: 2 * pos(v).x });
    const f = triangleFrame(p, turned)!;
    expect(f.angle).toBeCloseTo(90);
    expect(f.length).toBeCloseTo(4);
    // A single vertex: no frame.
    expect(triangleFrame({ vertices: [4, 4, 4], weights: [1, 0, 0] }, pos)).toBeUndefined();
  });
});
