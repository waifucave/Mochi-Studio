import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RECENT, RecentModels } from '../../desktop/recent.ts';

const home = mkdtempSync(join(tmpdir(), 'mochi-recent-'));
const model = (name: string): string => {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.model3.json`), '{}');
  return dir;
};

describe('recent models (desktop app)', () => {
  it('keeps folders newest first, once each, at most ten', () => {
    const r = new RecentModels(join(home, 'data', 'recent.json'));
    const a = model('A');
    const b = model('B');
    r.add(a, 1);
    r.add(b, 2);
    r.add(a, 3);
    expect(r.list().map((x) => [x.label, x.state])).toEqual([
      ['A', 'ok'],
      ['B', 'ok'],
    ]);
    for (let i = 0; i < 12; i++) r.add(model(`M${i}`), 10 + i);
    expect(r.list()).toHaveLength(MAX_RECENT);
    expect(r.list()[0]!.label).toBe('M11');
  });

  it('says when a folder has moved or no longer holds a model, and forgets on request', () => {
    const r = new RecentModels(join(home, 'data2', 'recent.json'));
    const moved = model('Moved');
    const emptied = model('Emptied');
    // A model one level down still counts (a folder that holds the model's folder).
    const outer = join(home, 'Outer');
    mkdirSync(outer);
    renameSync(model('Inner'), join(outer, 'Inner'));
    r.add(moved);
    r.add(emptied);
    r.add(outer);
    renameSync(moved, join(home, 'Elsewhere'));
    rmSync(join(emptied, 'Emptied.model3.json'));
    expect(Object.fromEntries(r.list().map((x) => [x.label, x.state]))).toEqual({
      Outer: 'ok',
      Emptied: 'no-model',
      Moved: 'missing',
    });
    r.forget(moved);
    expect(r.has(moved)).toBe(false);
    expect(r.list()).toHaveLength(2);
  });

  it('reads a damaged list as empty', () => {
    const f = join(home, 'bad.json');
    writeFileSync(f, 'not json');
    expect(new RecentModels(f).list()).toEqual([]);
  });

  it('remembers zips, and says when one has gone', () => {
    const r = new RecentModels(join(home, 'data3', 'recent.json'));
    const zip = join(home, 'Model.zip');
    writeFileSync(zip, 'PK');
    r.add(zip);
    expect(r.list()[0]).toMatchObject({ label: 'Model.zip', state: 'ok' });
    rmSync(zip);
    expect(r.list()[0]!.state).toBe('missing');
  });
});
