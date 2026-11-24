import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkAssets,
  checkRelease,
  expectedFiles,
  findFiles,
  gate,
  gitHub,
  hasChangelogSection,
  packageVersion,
  publishRelease,
  releaseNotes,
  releaseStart,
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

/**
 * A GitHub that keeps tags and releases as GitHub does: a draft has no tag;
 * publishing it creates the tag at its target commit, unless the tag exists.
 */
function fakeGitHub(o: { tags?: Record<string, string>; failUpload?: string } = {}) {
  const tags = new Map(Object.entries(o.tags ?? {}));
  const releases: any[] = [];
  const calls: string[] = [];
  let next = 1;
  const gh = {
    tags,
    releases,
    calls,
    async tagCommit(tag: string) {
      calls.push(`tag ${tag}`);
      return tags.get(tag);
    },
    async releasesFor(tag: string) {
      return releases.filter((r) => r.tag_name === tag);
    },
    async createDraft(r: any) {
      calls.push('create draft');
      const rel = { ...r, id: next++, draft: true, assets: [] as any[], html_url: 'https://x/r' };
      releases.push(rel);
      return rel;
    },
    async upload(rel: any, name: string, bytes: Buffer) {
      if (name === o.failUpload) throw new Error(`upload ${name}: 500`);
      rel.assets.push({ name, size: bytes.length, state: 'uploaded', digest: sha(bytes) });
    },
    async assets(id: number) {
      return releases.find((r) => r.id === id)?.assets;
    },
    async publish(id: number) {
      calls.push('publish');
      const r = releases.find((x) => x.id === id);
      r.draft = false;
      if (!tags.has(r.tag_name)) tags.set(r.tag_name, r.target_commitish);
    },
    async remove(id: number) {
      calls.push('delete draft');
      releases.splice(
        releases.findIndex((r) => r.id === id),
        1,
      );
    },
  };
  return gh;
}
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const file = (name: string, text: string) => {
  const bytes = Buffer.from(text);
  return {
    name,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: () => bytes,
  };
};
const files = () => (expectedFiles(version) as string[]).map((n) => file(n, `${n} bytes`));
const byHand = { how: 'dispatch', tag: `v${version}`, version };
const byTag = { how: 'tag', tag: `v${version}`, version };
const onMain = { ref: 'refs/heads/main', sha: 'c0ffee', only: 'all' };
const text = { title: 'Mochi Studio', notes: 'Notes.' };
const quiet = () => undefined;

describe('the start of a release', () => {
  it('is a pushed tag, or a run by hand with release checked; else none', () => {
    const tag = releaseStart({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/v${version}` });
    expect(tag).toMatchObject({ how: 'tag', tag: `v${version}` });
    expect(releaseStart({ GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE: 'true' })).toMatchObject(
      { how: 'dispatch', tag: `v${version}` },
    );
    expect(releaseStart({ GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE: 'false' }).how).toBe(
      undefined,
    );
    expect(releaseStart({ GITHUB_EVENT_NAME: 'workflow_dispatch' }).how).toBe(undefined);
  });
});

describe('the gate', () => {
  it('lets a run by hand on main through when there is no tag and no release', async () => {
    expect(await gate(byHand, onMain, fakeGitHub())).toEqual([]);
  });

  it('stops a run by hand off main, or for only part of the jobs', async () => {
    const problems = await gate(
      byHand,
      { ref: 'refs/heads/other', sha: 'c0ffee', only: 'spout' },
      fakeGitHub(),
    );
    expect(problems).toEqual([
      'A release is made from the branch main; this run is on refs/heads/other. Run the workflow on main.',
      'A release runs every job: choose "all", not "spout".',
    ]);
    expect(
      await gate(byHand, { ...onMain, ref: `refs/tags/v${version}` }, fakeGitHub()),
    ).toHaveLength(1);
  });

  it('stops when the tag or a release exists, a draft included', async () => {
    const gh = fakeGitHub({ tags: { [`v${version}`]: 'abc' } });
    gh.releases.push({ id: 7, tag_name: `v${version}`, draft: false, html_url: 'https://x/7' });
    gh.releases.push({ id: 8, tag_name: `v${version}`, draft: true, html_url: 'https://x/8' });
    expect(await gate(byHand, onMain, gh)).toEqual([
      `The tag v${version} exists already (at abc): this version has been released.`,
      `The release v${version} exists (https://x/7).`,
      `A draft release for v${version} exists (https://x/8), maybe from a failed run: delete it on the Releases page, then run again.`,
    ]);
  });

  it("lets a tag's run through when its tag is at the run's commit", async () => {
    const run = { ref: `refs/tags/v${version}`, sha: 'c0ffee', only: '' };
    expect(await gate(byTag, run, fakeGitHub({ tags: { [`v${version}`]: 'c0ffee' } }))).toEqual([]);
    expect(await gate(byTag, run, fakeGitHub({ tags: { [`v${version}`]: 'beef' } }))).toEqual([
      `The tag v${version} points at beef, not at this run's commit c0ffee.`,
    ]);
  });

  it('checks the version, the changelog and the notes, as before', async () => {
    expect(await gate({ ...byHand, tag: 'v9.9.9' }, onMain, fakeGitHub())).toContain(
      `The tag is v9.9.9, but package.json's version is ${version} (the tag must be v${version}).`,
    );
  });
});

describe('making the release', () => {
  it('by hand: a draft with every file checked, then published; the tag comes with it', async () => {
    const gh = fakeGitHub();
    await publishRelease(byHand, onMain, files(), text, gh, quiet);
    const [r] = gh.releases;
    expect(r).toMatchObject({ tag_name: `v${version}`, target_commitish: 'c0ffee', draft: false });
    expect(r.prerelease).toBe(true);
    expect(r.assets.map((a: any) => a.name)).toEqual(expectedFiles(version));
    expect(gh.tags.get(`v${version}`)).toBe('c0ffee');
    // The gate ran again between the draft and the publish.
    expect(gh.calls).toEqual([
      `tag v${version}`,
      'create draft',
      `tag v${version}`,
      'publish',
      `tag v${version}`,
    ]);
  });

  it('by a tag: the same calls, with the tag already there', async () => {
    const gh = fakeGitHub({ tags: { [`v${version}`]: 'c0ffee' } });
    await publishRelease(
      byTag,
      { ...onMain, ref: `refs/tags/v${version}` },
      files(),
      text,
      gh,
      quiet,
    );
    expect(gh.releases[0].draft).toBe(false);
    expect(gh.calls).toEqual([
      `tag v${version}`,
      'create draft',
      `tag v${version}`,
      'publish',
      `tag v${version}`,
    ]);
  });

  it('leaves no tag and no release when an upload fails', async () => {
    const gh = fakeGitHub({ failUpload: expectedFiles(version)[1] });
    await expect(publishRelease(byHand, onMain, files(), text, gh, quiet)).rejects.toThrow('500');
    expect(gh.releases).toEqual([]);
    expect(gh.tags.size).toBe(0);
    expect(gh.calls).toContain('delete draft');
    expect(gh.calls).not.toContain('publish');
  });

  it('leaves no tag and no release when the gate fails the second time', async () => {
    const gh = fakeGitHub();
    // Someone made the tag while the files went up.
    const upload = gh.upload.bind(gh);
    gh.upload = async (rel: any, name: string, bytes: Buffer) => {
      gh.tags.set(`v${version}`, 'beef');
      return upload(rel, name, bytes);
    };
    await expect(publishRelease(byHand, onMain, files(), text, gh, quiet)).rejects.toThrow(
      'exists already',
    );
    expect(gh.releases).toEqual([]);
    expect(gh.calls).not.toContain('publish');
  });

  it('does not start when the release exists (a second run)', async () => {
    const gh = fakeGitHub();
    await publishRelease(byHand, onMain, files(), text, gh, quiet);
    await expect(publishRelease(byHand, onMain, files(), text, gh, quiet)).rejects.toThrow(
      `The release v${version} exists`,
    );
    expect(gh.releases).toHaveLength(1);
  });

  it("checks each file's name, size and digest on the draft", () => {
    const [a, b] = [file('a', 'aaa'), file('b', 'bb')];
    expect(
      checkAssets(
        [a, b],
        [
          { name: 'a', size: 3, state: 'uploaded', digest: `sha256:${a.sha256}` },
          { name: 'b', size: 1, state: 'uploaded', digest: 'sha256:00' },
          { name: 'c', size: 1, state: 'uploaded' },
        ],
      ),
    ).toEqual([
      'b is 1 bytes on the draft, 2 here.',
      `b's digest on the draft is sha256:00, here sha256:${b.sha256}.`,
      'c should not be on the draft.',
    ]);
    expect(checkAssets([a], [])).toEqual(['a is not on the draft.']);
  });
});

describe("the calls to GitHub's REST API", () => {
  it('follow an annotated tag, read a 404 as none, and send files to the upload address', async () => {
    const seen: Array<[string, string]> = [];
    const answers: Record<string, [number, unknown]> = {
      'GET https://api.test/repos/o/r/git/ref/tags/v1': [
        200,
        { object: { type: 'tag', sha: 't1' } },
      ],
      'GET https://api.test/repos/o/r/git/tags/t1': [
        200,
        { object: { type: 'commit', sha: 'c1' } },
      ],
      'GET https://api.test/repos/o/r/git/ref/tags/v2': [404, {}],
      'POST https://uploads.test/repos/o/r/releases/5/assets?name=a%20b.zip': [201, { id: 1 }],
      'PATCH https://api.test/repos/o/r/releases/5': [500, 'no'],
    };
    const fetch = async (url: string, init: any) => {
      seen.push([init.method, init.headers['content-type'] ?? '']);
      const [status, body] = answers[`${init.method} ${url}`] ?? [418, {}];
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        text: async () => String(body),
      };
    };
    const gh = gitHub({ api: 'https://api.test', repository: 'o/r', token: 't', fetch });
    expect(await gh.tagCommit('v1')).toBe('c1');
    expect(await gh.tagCommit('v2')).toBe(undefined);
    const rel = { upload_url: 'https://uploads.test/repos/o/r/releases/5/assets{?name,label}' };
    expect(await gh.upload(rel, 'a b.zip', Buffer.from('x'))).toEqual({ id: 1 });
    expect(seen.at(-1)).toEqual(['POST', 'application/octet-stream']);
    await expect(gh.publish(5)).rejects.toThrow('PATCH /releases/5: 500');
  });
});

describe('the workflow (.github/workflows/desktop.yml)', () => {
  const yml = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  /** A job's lines, up to the next job. */
  const job = (name: string) => {
    const from = yml.indexOf(`\n  ${name}:\n`);
    const rest = yml.slice(from + 1);
    const end = rest.slice(1).search(/\n {2}[a-z]+:\n/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  };

  it('has the release checkbox, off by default, and still a tag start', () => {
    expect(yml).toMatch(/release:\n\s+description: .+\n\s+type: boolean\n\s+default: false/);
    expect(yml).toContain("tags: ['v*']");
  });

  it('runs the gate before anything is built, and the release after everything', () => {
    for (const name of ['package', 'spout', 'vcam']) expect(job(name)).toContain('needs: gate');
    expect(job('gate')).toContain('node scripts/release.mjs gate');
    const release = job('release');
    expect(release).toContain("if: needs.gate.outputs.release == 'true'");
    expect(release).toContain('needs: [gate, package, spout, vcam]');
    expect(release).toContain('node scripts/release.mjs publish');
    // The release is made by the script's calls only (one path for both starts).
    expect(yml).not.toContain('gh release create');
  });
});
