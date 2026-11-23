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
//
// test/unit/release.test.ts tests these, and that the names agree with
// desktop/electron-builder.json.
import {
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
  fail([`Unknown command: ${command ?? '(none)'}. Use check or stage.`]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
