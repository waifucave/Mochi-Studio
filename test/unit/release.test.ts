import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRelease,
  expectedFiles,
  findFiles,
  hasChangelogSection,
  packageVersion,
  releaseNotes,
  // @ts-expect-error: a plain JavaScript module, without types.
} from '../../scripts/release.mjs';

/**
 * The release job's checks (scripts/release.mjs): nothing is published
 * unless the tag, the version, the changelog, the notes and the packages
 * agree. Each check is tried on a made-up tree that fails it.
 */
const version = packageVersion() as string;

/** A folder with a package.json, and the changelog and notes given. */
const tree = (o: { version?: string; changelog?: string | null; notes?: string | null }) => {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-release-'));
  const v = o.version ?? '1.2.3';
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: v }));
  if (o.changelog !== null)
    writeFileSync(join(dir, 'CHANGELOG.md'), o.changelog ?? `# Changelog\n\n## ${v}\n\nThings.\n`);
  if (o.notes !== null) {
    mkdirSync(join(dir, 'docs', 'releases'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'releases', `${v}.md`), o.notes ?? `# ${v}\n\nNotes.\n`);
  }
  return dir;
};

describe('the release checks', () => {
  it('pass for this repository at the tag v + its version', () => {
    expect(checkRelease(`v${version}`)).toEqual([]);
  });

  it('refuse a tag that is not v + the version', () => {
    const dir = tree({});
    expect(checkRelease('v1.2.3', dir)).toEqual([]);
    expect(checkRelease('v1.2.4', dir)).toEqual([
      "The tag is v1.2.4, but package.json's version is 1.2.3 (the tag must be v1.2.3).",
    ]);
    expect(checkRelease('1.2.3', dir)).toHaveLength(1);
  });

  it('refuse without a changelog section or notes for the version', () => {
    expect(checkRelease('v1.2.3', tree({ changelog: null }))).toEqual([
      'There is no CHANGELOG.md.',
    ]);
    expect(checkRelease('v1.2.3', tree({ changelog: '# Changelog\n\n## 1.2.2\n' }))).toEqual([
      'CHANGELOG.md has no section for 1.2.3 ("## 1.2.3").',
    ]);
    expect(checkRelease('v1.2.3', tree({ notes: null }))).toEqual([
      'There are no release notes for 1.2.3 (docs/releases/1.2.3.md).',
    ]);
  });

  it('read a changelog section with or without a date or brackets, and no other version', () => {
    expect(hasChangelogSection('## 1.2.3\n', '1.2.3')).toBe(true);
    expect(hasChangelogSection('## [1.2.3] - 2026-11-23\n', '1.2.3')).toBe(true);
    expect(hasChangelogSection('## 1.2.30\n', '1.2.3')).toBe(false);
    expect(hasChangelogSection('## 1x2x3\n', '1.2.3')).toBe(false);
    expect(hasChangelogSection('Text about 1.2.3\n', '1.2.3')).toBe(false);
  });

  it('find every package and note in the artifacts, and refuse a missing, doubled or empty one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-artifacts-'));
    const files = expectedFiles('1.2.3') as string[];
    // One folder per artifact, as download-artifact makes them.
    files.forEach((f, i) => {
      const sub = join(dir, `mochi-studio-${i % 3}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, f), 'x');
    });
    const ok = findFiles('1.2.3', dir);
    expect(ok.problems).toEqual([]);
    expect(ok.files).toHaveLength(6);

    writeFileSync(join(dir, 'mochi-studio-0', files[0]!), '');
    writeFileSync(join(dir, 'mochi-studio-1', files[3]!), 'x');
    const bad = findFiles('1.2.4', dir);
    // Another version: none of its packages are there (the notes, named without one, are).
    expect(bad.problems).toEqual([
      'Mochi-Studio-1.2.4-linux-x86_64.AppImage is missing.',
      'Mochi-Studio-1.2.4-windows-x64.zip is missing.',
      'Mochi-Studio-1.2.4-macos-arm64.zip is missing.',
      'HOW-TO-OPEN-linux.txt is there 2 times.',
    ]);
    const problems = findFiles('1.2.3', dir).problems;
    expect(problems).toEqual([`${files[0]} is empty.`, `${files[3]} is there 2 times.`]);
  });

  it('name a package for each system, and a note for each', () => {
    expect(expectedFiles('1.2.3')).toEqual([
      'Mochi-Studio-1.2.3-linux-x86_64.AppImage',
      'Mochi-Studio-1.2.3-windows-x64.zip',
      'Mochi-Studio-1.2.3-macos-arm64.zip',
      'HOW-TO-OPEN-linux.txt',
      'HOW-TO-OPEN-windows.txt',
      'HOW-TO-OPEN-macos.txt',
    ]);
    for (const os of ['linux', 'windows', 'macos'])
      expect(
        readFileSync(new URL(`../../desktop/how-to-open/${os}.txt`, import.meta.url), 'utf8'),
      ).toContain(
        (expectedFiles('<version>') as string[]).find((f) => f.includes(`-${os}-`)) as string,
      );
  });

  it("add where to report a problem to the notes, with the repository's address", () => {
    const notes = releaseNotes(version, 'https://github.com/example/mochi-studio') as string;
    expect(notes).toContain('## Reporting a problem');
    expect(notes).toContain('https://github.com/example/mochi-studio/issues');
    expect(notes).toContain('https://github.com/example/mochi-studio/security/advisories/new');
    expect(notes).not.toContain('<!--');
  });
});
