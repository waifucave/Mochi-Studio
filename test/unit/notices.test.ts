import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain JavaScript script, without types.
import { notices, OUT } from '../../scripts/notices.mjs';

const file = () => readFileSync(OUT, 'utf8');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('THIRD_PARTY_NOTICES.md', () => {
  it('is what the generator writes from what the build bundles (npm run notices)', async () => {
    expect(file()).toBe(await notices());
  }, 60_000);

  it('names the Mochi2D version package.json asks for, with its own notices', () => {
    const spec = json('package.json').dependencies.mochi2d as string;
    const wanted = /mochi2d-(\d+\.\d+\.\d+)\.tgz$/.exec(spec)?.[1] ?? spec;
    expect(json('node_modules/mochi2d/package.json').version).toBe(wanted);
    expect(file()).toMatch(
      new RegExp(`\\| mochi2d +\\| ${wanted.replace(/\./g, '\\.')} +\\| MIT +\\|`),
    );
    expect(file()).toContain(`## mochi2d ${wanted}`);
    expect(file()).toContain(`Mochi2D ${wanted} lists the third-party code it includes`);
  });

  it('lists every runtime dependency at its installed version, with a license text', () => {
    const t = file();
    for (const name of Object.keys(json('package.json').dependencies)) {
      const v = json(`node_modules/${name}/package.json`).version;
      expect(t, name).toContain(`## ${name} ${v}`);
    }
    // Each package's section has its license text (or points to the Apache text below).
    for (const section of t.split(/\n## /).slice(1)) {
      if (/^(Apache License 2\.0|Mochi2D's own notices)/.test(section)) continue;
      expect(section, section.split('\n')[0]).toMatch(/```text\n|"Apache License 2\.0" below/);
    }
    expect(t).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    expect(t).toMatch(/\| electron +\|/);
    expect(t).toContain('MediaPipe face and hand landmarker models');
    expect(t).toContain('Spout2 SDK');
  });

  it('goes into every desktop package, beside Electron’s own license files', () => {
    const b = json('desktop/electron-builder.json');
    expect(b.files).toContain('THIRD_PARTY_NOTICES.md');
    expect(b.files).toContain('LICENSE');
    expect(b.extraFiles).toEqual(
      expect.arrayContaining([
        { from: 'dist/app/THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
      ]),
    );
    const build = readFileSync('desktop/build.mjs', 'utf8');
    expect(build).toMatch(/cpSync\(here\('\.\.\/THIRD_PARTY_NOTICES\.md'\)/);
  });
});
