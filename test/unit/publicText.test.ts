import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The public tree is everything outside `cleanroom/` (the clean-room record,
 * kept private). It must stand on its own: no references to that record, to
 * the process's private documents or to the people and sessions behind
 * them. Each pattern is one kind of reference; a match fails with the file
 * and line.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ['a brief cited by number', /\b[Ii]nbox[ /-]?\d{3,4}\b/],
  ['a path into the clean-room record', /cleanroom\//],
  ['a round report', /\bround-\d+\.md\b|\b[Rr]ound[ -]\d+\b/],
  ['a research label', /\b(?:maker|vts|params)-\d+\b|\bchecks? [A-Z]\d+\b/],
  ['a research mark', /\b(?:VERIFIED|INFERRED)\b/],
  ['the research side', /\bresearch side\b/i],
  ['a process role', /\bthe (?:coordinator|owner)\b/i],
  ['a session link', /claude\.ai\/code\/session|\bsession_0[0-9A-Za-z]{8,}/],
  ['a section of a private specification', /\((?:the )?(?:appendix|spec) [0-9T][\d.]*/],
  ['a word for the review behind publication', /\blegal review\b|\blawyers?\b|\battorneys?\b/i],
];

/** Lines that name these products must say what Mochi Studio is not, never what it is to them. */
const NAMES = /\bLive2D\b|\bCubism\b|\bVTube Studio\b|\bDenchiSoft\b/;
const CLAIMS = /\bclone\b|\balternative to\b|\bofficial\b|\bdrop-in replacement\b/i;

/** Files that are not text, or are written by tools from third-party data. */
const SKIP = [
  /^cleanroom\//,
  /^CLEANROOM\.md$/,
  /^THIRD_PARTY_NOTICES\.md$/, // the packages' own license texts and notices
  /^package-lock\.json$/,
  /^vendor\//,
  /^test\/fixtures\//,
  /\.(?:png|jpe?g|gif|webp|ico|icns|tgz|zip|wasm|task|moc3|node)$/,
];

/**
 * The tree's files: git's list in a checkout of this tree; otherwise (a
 * downloaded source archive) the folder itself, leaving out what
 * `.gitignore` names, `node_modules` and `.git`.
 */
function treeFiles(): string[] {
  const root = process.cwd();
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (realpathSync(top) === realpathSync(root))
      return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8',
      }).split('\n');
  } catch {
    // Not a git checkout, or no git: the folder below.
  }
  const ignored = ignoreRules(root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = relative(root, join(dir, e.name)).split(sep).join('/');
      if (e.name === '.git' || e.name === 'node_modules' || ignored(path, e.isDirectory()))
        continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile()) out.push(path);
    }
  };
  walk(root);
  return out;
}

/** The root `.gitignore`'s rules, as this tree uses them: names, `dir/`, paths and `*` globs. */
function ignoreRules(root: string): (path: string, dir: boolean) => boolean {
  const file = join(root, '.gitignore');
  const rules = (existsSync(file) ? readFileSync(file, 'utf8') : '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => {
      const dirOnly = l.endsWith('/');
      const body = l.replace(/^\//, '').replace(/\/$/, '');
      // A pattern with a slash in it is a path from the root; without, a name anywhere.
      const anchored = body.includes('/');
      const re = new RegExp(
        `^${body
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')}$`,
      );
      return { dirOnly, anchored, re };
    });
  return (path, dir) =>
    rules.some(
      (r) =>
        (!r.dirOnly || dir) && (r.anchored ? r.re.test(path) : r.re.test(path.split('/').pop()!)),
    );
}

const files = treeFiles().filter((f) => f && !SKIP.some((p) => p.test(f)));

/** This file names the patterns it looks for. */
const SELF = 'test/unit/publicText.test.ts';

describe('the public tree', () => {
  it('has no private references outside cleanroom/', () => {
    const found: string[] = [];
    for (const f of files) {
      if (f === SELF) continue;
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue; // deleted in the working tree
      }
      text.split('\n').forEach((line, i) => {
        for (const [what, re] of PATTERNS)
          if (re.test(line)) found.push(`${f}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('names Live2D, Cubism and VTube Studio only descriptively', () => {
    const found: string[] = [];
    for (const f of files) {
      if (f === SELF || f === 'TERMS.md') continue;
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (NAMES.test(line) && CLAIMS.test(line))
          found.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('carries the review’s wording: the footer, how it was made, and patents', () => {
    const footer =
      'Live2D and Live2D Cubism are trademarks or registered trademarks of Live2D Inc. VTube Studio is a product of DenchiSoft. Mochi Studio is an independent project. It is not affiliated with, endorsed by, sponsored by or supported by either, and it contains none of their code or files.';
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain(footer);
    expect(readFileSync('TERMS.md', 'utf8')).toContain(footer);
    expect(readme).toContain(
      "**How it was made.** Most of this code was written by AI coding agents (Anthropic's Claude) under the direction of the project's maintainer, through the clean-room process in [CLEANROOM.md](CLEANROOM.md). Copyright may not subsist in every part of it. To the extent it does, it is licensed under the MIT License. Either way, it is provided as is, without warranty. Third-party code keeps its own licenses ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).",
    );
    expect(readme).toContain(
      '## Patents\n\nThis project is licensed under the MIT License, which grants no patent rights. Reading some model files uses techniques, such as joining meshes ("glue") and blend shapes, that may be covered by third-party patents in some countries, including Japan and the United States. The project has taken no legal opinion on this, and makes no statement that any patent is or is not infringed. If you use or distribute it in such a country, above all commercially, check for yourself whether you need a license.',
    );
    // Patents come before the footer.
    expect(readme.indexOf('## Patents')).toBeLessThan(readme.indexOf(footer));
  });
});
