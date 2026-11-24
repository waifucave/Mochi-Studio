// The release job's checks and files (.github/workflows/desktop.yml, on a
// version tag only). Nothing is published unless every check passes:
//
//   node scripts/release.mjs check <tag>
//     the tag is "v" + package.json's version, CHANGELOG.md has a section
//     for that version, and docs/releases/<version>.md has its notes;
//   node scripts/release.mjs stage <tag> <artifacts dir> <out dir> <notes file> <repository URL>
//     every expected package and how-to-open note is in the downloaded
//     artifacts (and nothing is empty); copies them into <out dir>, and
//     writes the release notes to <notes file>.
//   node scripts/release.mjs gate
//     the gate, before anything is built (the workflow's first job): whether
//     this run makes a release, and if it does, that it may (below);
//   node scripts/release.mjs publish <files dir> <notes file>
//     makes the release: a draft with every file, checked, then the gate
//     again, then published, which creates the tag at the run's commit.
//
// A release starts in one of two ways, which share every step:
//
//   - a version tag pushed by hand ("tag"): the tag exists already, at the
//     commit the run is on;
//   - the workflow run by hand on main with `release` checked ("dispatch"):
//     there is no tag yet; it comes into being when the release is published.
//
// They differ only in the gate: a tag's run needs its tag to point at the
// run's commit (GET git/ref/tags/<tag>); a run by hand needs to be on main
// and that GET to find no tag. The release is made by the same calls in both:
// POST releases (a draft, tag_name and target_commitish = the run's commit),
// one upload per file, GET its assets, the gate again, PATCH draft: false.
// GitHub makes a draft's tag only when it is published, so whatever fails
// before that leaves no tag and no public release, and the draft is deleted.
//
// test/unit/release.test.ts tests these, and that the names agree with
// desktop/electron-builder.json.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** package.json's version. */
export function packageVersion(dir = root) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
}

/** The files a release has: each system's package and its how-to-open note. */
export function expectedFiles(version) {
  return [
    `Mochi-Studio-${version}-linux-x86_64.AppImage`,
    `Mochi-Studio-${version}-windows-x64.zip`,
    `Mochi-Studio-${version}-macos-arm64.zip`,
    'HOW-TO-OPEN-linux.txt',
    'HOW-TO-OPEN-windows.txt',
    'HOW-TO-OPEN-macos.txt',
  ];
}

/** Whether CHANGELOG.md has a section for the version ("## 0.1.0", maybe with a date after it). */
export function hasChangelogSection(changelog, version) {
  const v = version.replace(/\./g, '\\.');
  return new RegExp(`^## \\[?${v}\\]?(\\s|$)`, 'm').test(changelog);
}

/** The problems with releasing `tag` from `dir`; none: it may be released. */
export function checkRelease(tag, dir = root) {
  const version = packageVersion(dir);
  const problems = [];
  if (tag !== `v${version}`)
    problems.push(
      `The tag is ${tag}, but package.json's version is ${version} (the tag must be v${version}).`,
    );
  const changelog = join(dir, 'CHANGELOG.md');
  if (!existsSync(changelog)) problems.push('There is no CHANGELOG.md.');
  else if (!hasChangelogSection(readFileSync(changelog, 'utf8'), version))
    problems.push(`CHANGELOG.md has no section for ${version} ("## ${version}").`);
  if (!existsSync(notesFile(version, dir)))
    problems.push(`There are no release notes for ${version} (docs/releases/${version}.md).`);
  return problems;
}

export function notesFile(version, dir = root) {
  return join(dir, 'docs', 'releases', `${version}.md`);
}

/**
 * The release notes: docs/releases/<version>.md, and where to report a
 * problem, with this repository's address (which the file can't know).
 */
export function releaseNotes(version, repository, dir = root) {
  const notes = readFileSync(notesFile(version, dir), 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '');
  return `${notes.trimEnd()}

## Reporting a problem

- **A bug, or something that doesn't work as these notes say:** open an issue at
  ${repository}/issues. In the app, main menu → Log → "Save for a bug report…" saves a
  file to attach (the app's version, a few counts and the log; no pictures, sound or models).
- **A security problem:** report it privately, at ${repository}/security/advisories/new
  ([SECURITY.md](${repository}/blob/v${version}/SECURITY.md)), not in an issue.
`;
}

/** Every file under `dir` (the downloaded artifacts: one folder per artifact). */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => statSync(f).isFile());
}

/** The problems with the artifacts in `dir` for `version`, and the files to release. */
export function findFiles(version, dir) {
  const found = new Map();
  for (const f of filesUnder(dir)) {
    const list = found.get(basename(f)) ?? [];
    list.push(f);
    found.set(basename(f), list);
  }
  const problems = [];
  const files = [];
  for (const name of expectedFiles(version)) {
    const at = found.get(name) ?? [];
    if (at.length === 0) problems.push(`${name} is missing.`);
    else if (at.length > 1) problems.push(`${name} is there ${at.length} times.`);
    else if (statSync(at[0]).size === 0) problems.push(`${name} is empty.`);
    else files.push(at[0]);
  }
  return { problems, files };
}

// ---------------------------------------------------------------------------
// The release itself: the gate, and the draft that becomes the release.

/**
 * What this run is asked to do, from the workflow's environment: no release
 * (`how` undefined), or a release started by a tag ("tag") or by hand
 * ("dispatch"), with the tag it is for.
 */
export function releaseStart(env, dir = root) {
  const version = packageVersion(dir);
  if (env.GITHUB_EVENT_NAME === 'push' && (env.GITHUB_REF ?? '').startsWith('refs/tags/'))
    return { how: 'tag', tag: env.GITHUB_REF.slice('refs/tags/'.length), version };
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RELEASE === 'true')
    return { how: 'dispatch', tag: `v${version}`, version };
  return { how: undefined, tag: `v${version}`, version };
}

/**
 * A few GitHub REST calls, with the run's token (`fetch` given for the tests). GETs answer
 * undefined for a 404; anything else that is not 2xx throws.
 */
export function gitHub({ api, repository, token, fetch: f = globalThis.fetch }) {
  const call = async (method, path, body, contentType) => {
    const url = path.startsWith('https://') ? path : `${api}/repos/${repository}${path}`;
    const r = await f(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined ? { 'content-type': contentType ?? 'application/json' } : {}),
      },
      body: body === undefined || contentType ? body : JSON.stringify(body),
    });
    if (r.status === 404 && method === 'GET') return undefined;
    if (!r.ok) throw new Error(`${method} ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? undefined : r.json();
  };
  return {
    /** The commit a tag points at (an annotated tag followed), or undefined: no such tag. */
    async tagCommit(tag) {
      const ref = await call('GET', `/git/ref/tags/${encodeURIComponent(tag)}`);
      let o = ref?.object;
      while (o && o.type === 'tag') o = (await call('GET', `/git/tags/${o.sha}`))?.object;
      return o?.sha;
    },
    /** Every release for the tag, drafts included (the token can write, so it sees them). */
    async releasesFor(tag) {
      const all = [];
      for (let page = 1; ; page++) {
        const list = (await call('GET', `/releases?per_page=100&page=${page}`)) ?? [];
        all.push(...list);
        if (list.length < 100) break;
      }
      return all.filter((r) => r.tag_name === tag);
    },
    createDraft: (o) => call('POST', '/releases', { ...o, draft: true }),
    upload: (release, name, bytes) =>
      call(
        'POST',
        `${release.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`,
        bytes,
        'application/octet-stream',
      ),
    assets: (id) => call('GET', `/releases/${id}/assets?per_page=100`),
    publish: (id) => call('PATCH', `/releases/${id}`, { draft: false }),
    remove: (id) => call('DELETE', `/releases/${id}`),
  };
}

/**
 * The gate: the problems with making the release now (none: it may be made). The same checks
 * run before anything is built and again just before the release is published; `ours` is the
 * draft this run made, which is not a problem.
 */
export async function gate(start, { ref, sha, only }, gh, ours, dir = root) {
  const { how, tag } = start;
  const problems = checkRelease(tag, dir);
  if (how === 'dispatch') {
    if (ref !== 'refs/heads/main')
      problems.push(
        `A release is made from the branch main; this run is on ${ref}. Run the workflow on main.`,
      );
    if (only && only !== 'all')
      problems.push(`A release runs every job: choose "all", not "${only}".`);
  }
  const at = await gh.tagCommit(tag);
  if (how === 'dispatch' && at)
    problems.push(`The tag ${tag} exists already (at ${at}): this version has been released.`);
  if (how === 'tag' && at !== sha)
    problems.push(`The tag ${tag} points at ${at ?? 'nothing'}, not at this run's commit ${sha}.`);
  for (const r of await gh.releasesFor(tag)) {
    if (ours !== undefined && r.id === ours) continue;
    problems.push(
      r.draft
        ? `A draft release for ${tag} exists (${r.html_url}), maybe from a failed run: delete it on the Releases page, then run again.`
        : `The release ${tag} exists (${r.html_url}).`,
    );
  }
  return problems;
}

/** The problems with the draft's assets against the files sent (name, size, and digest). */
export function checkAssets(files, assets) {
  const problems = [];
  const byName = new Map(assets.map((a) => [a.name, a]));
  for (const f of files) {
    const a = byName.get(f.name);
    if (!a) {
      problems.push(`${f.name} is not on the draft.`);
      continue;
    }
    if (a.state !== 'uploaded') problems.push(`${f.name} is ${a.state} on the draft.`);
    if (a.size !== f.size)
      problems.push(`${f.name} is ${a.size} bytes on the draft, ${f.size} here.`);
    if (a.digest && a.digest !== `sha256:${f.sha256}`)
      problems.push(`${f.name}'s digest on the draft is ${a.digest}, here sha256:${f.sha256}.`);
  }
  for (const a of assets)
    if (!files.some((f) => f.name === a.name))
      problems.push(`${a.name} should not be on the draft.`);
  return problems;
}

/**
 * Makes the release: the gate, a draft with every file, the files checked, the gate again,
 * then the draft published (which creates the tag at `sha` when there is none). Whatever fails
 * before it is published, the draft is deleted: no tag and no public release are left.
 */
export async function publishRelease(start, run, files, { title, notes }, gh, log = console.log) {
  const fail = (problems) => {
    const e = new Error(problems.join('\n'));
    e.problems = problems;
    return e;
  };
  let problems = await gate(start, run, gh);
  if (problems.length) throw fail(problems);
  const draft = await gh.createDraft({
    tag_name: start.tag,
    target_commitish: run.sha,
    name: title,
    body: notes,
    prerelease: true,
  });
  log(`Draft ${draft.id} for ${start.tag} at ${run.sha}.`);
  try {
    for (const f of files) {
      await gh.upload(draft, f.name, f.bytes());
      log(`${f.name}: ${f.size} bytes sent.`);
    }
    problems = checkAssets(files, (await gh.assets(draft.id)) ?? []);
    problems.push(...(await gate(start, run, gh, draft.id)));
    if (problems.length) throw fail(problems);
    await gh.publish(draft.id);
  } catch (e) {
    log(`Not published: the draft is deleted.`);
    await gh.remove(draft.id).catch((d) => log(`The draft ${draft.id} could not be deleted: ${d}`));
    throw e;
  }
  const at = await gh.tagCommit(start.tag);
  if (at !== run.sha)
    throw fail([
      `Published, but the tag ${start.tag} points at ${at ?? 'nothing'}, not ${run.sha}.`,
    ]);
  log(`Published ${start.tag} at ${run.sha}.`);
  return draft;
}

/** The files in `dir` to release, each with its size and SHA-256. */
export function releaseFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile())
    .map((p) => {
      const bytes = readFileSync(p);
      return {
        name: basename(p),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: () => readFileSync(p),
      };
    });
}

/** The run's facts, from the workflow's environment. */
function runFacts(env) {
  return { ref: env.GITHUB_REF, sha: env.GITHUB_SHA, only: env.ONLY };
}

function client(env) {
  return gitHub({
    api: env.GITHUB_API_URL ?? 'https://api.github.com',
    repository: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
  });
}

function main([command, tag, ...rest]) {
  const fail = (problems) => {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  };
  if (command === 'check') {
    const problems = checkRelease(tag ?? '');
    if (problems.length) fail(problems);
    console.log(`${tag}: the version, the changelog and the notes agree.`);
    return;
  }
  if (command === 'stage') {
    const [artifacts, out, notes, repository] = rest;
    if (!artifacts || !out || !notes || !repository)
      fail(['Usage: stage <tag> <artifacts> <out dir> <notes file> <repository URL>']);
    const problems = checkRelease(tag ?? '');
    const version = packageVersion();
    const found = findFiles(version, artifacts);
    if (problems.length || found.problems.length) fail([...problems, ...found.problems]);
    mkdirSync(out, { recursive: true });
    for (const f of found.files) {
      copyFileSync(f, join(out, basename(f)));
      console.log(`${basename(f)}: ${statSync(f).size} bytes`);
    }
    writeFileSync(notes, releaseNotes(version, repository));
    return;
  }
  fail([`Unknown command: ${command ?? '(none)'}. Use check, stage, gate or publish.`]);
}

/** The commands that call GitHub: gate and publish (the workflow's environment). */
async function mainAsync([command, ...rest]) {
  const env = process.env;
  const start = releaseStart(env);
  const out = (lines) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, lines);
  try {
    if (command === 'gate') {
      out(`release=${start.how ? 'true' : 'false'}\ntag=${start.tag}\n`);
      if (!start.how) {
        console.log('No release asked for: nothing is published.');
        return;
      }
      const problems = await gate(start, runFacts(env), client(env));
      if (problems.length) throw Object.assign(new Error(problems.join('\n')), { problems });
      console.log(
        `${start.tag} may be released (started by ${start.how === 'tag' ? 'its tag' : 'hand'}).`,
      );
      return;
    }
    if (command === 'publish') {
      const [dir, notes] = rest;
      if (!start.how) throw new Error('No release asked for.');
      const version = start.version;
      await publishRelease(
        start,
        runFacts(env),
        releaseFiles(dir),
        {
          title: `Mochi Studio ${version} (pre-release, unsigned)`,
          notes: readFileSync(notes, 'utf8'),
        },
        client(env),
      );
      return;
    }
  } catch (e) {
    for (const p of e.problems ?? [String(e.message ?? e)]) console.error(`::error::${p}`);
    process.exit(1);
  }
  main([command, ...rest]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void mainAsync(process.argv.slice(2));
