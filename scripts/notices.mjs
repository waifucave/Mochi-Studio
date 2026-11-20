// Writes THIRD_PARTY_NOTICES.md: every npm package that ships in the app (the
// web pages, the desktop app's main process, which includes the bridge) or in
// the bridge as npm installs it, with its license text in full; then
// MediaPipe's models, the Spout2 SDK, and Mochi2D's own notices.
//
//   npm run notices           writes the file
//   npm run notices -- --check fails when the file is out of date
//
// What ships is read from the bundler, not guessed: esbuild bundles the
// entry points without writing anything, and the packages its inputs come
// from are the ones listed. Vite builds the pages from the same imports.
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => join(root, ...p);
export const OUT = at('THIRD_PARTY_NOTICES.md');

/** The package a bundled file comes from: the innermost node_modules entry. */
function packageOf(file) {
  const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(?!node_modules)[^]*)?$/.exec(
    file.replace(/\\/g, '/'),
  );
  if (!m) return undefined;
  const i = file.replace(/\\/g, '/').lastIndexOf(`node_modules/${m[1]}/`);
  return {
    name: m[1],
    dir: join(root, file.replace(/\\/g, '/').slice(0, i), 'node_modules', m[1]),
  };
}

async function bundled(options) {
  const r = await build({
    ...options,
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    outdir: at('.notices-tmp'),
    logLevel: 'silent',
  });
  const found = new Map();
  for (const f of Object.keys(r.metafile.inputs)) {
    const p = packageOf(f);
    if (p) found.set(p.dir, p);
  }
  return [...found.values()];
}

/** A package's runtime dependency tree, as npm installs it (for the bridge). */
function installed(name, from = root, seen = new Map()) {
  let dir = from;
  for (;;) {
    const d = join(dir, 'node_modules', name);
    if (existsSync(join(d, 'package.json'))) {
      if (seen.has(d)) return seen;
      seen.set(d, { name, dir: d });
      const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      for (const dep of Object.keys(pkg.dependencies ?? {})) installed(dep, d, seen);
      return seen;
    }
    if (dir === root) return seen;
    dir = dirname(dir);
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
function licenseTexts(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim());
}

/** The first copyright line in a package's JavaScript (for packages without a license file). */
function copyrightOf(dir) {
  const files = [];
  const walk = (d, depth) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.name === 'node_modules' || f.name === 'test') continue;
      if (f.isDirectory() && depth < 2) walk(join(d, f.name), depth + 1);
      else if (/\.(m?js|cjs)$/.test(f.name)) files.push(join(d, f.name));
    }
  };
  walk(dir, 0);
  for (const f of files.sort()) {
    const m = /Copyright \(c\) [^\n]+/.exec(readFileSync(f, 'utf8'));
    if (m) return m[0].trim();
  }
  return undefined;
}

/** Notices a package asks to be kept beside its license. */
const EXTRA = {
  'qrcode-generator': "The word 'QR Code' is a registered trademark of DENSO WAVE INCORPORATED.",
};

const where = {
  web: 'the app’s pages',
  desktop: 'the desktop app',
  bridge: 'the bridge (npm)',
};

/** The notices' text, formatted as the repository's Prettier settings format Markdown. */
export async function notices() {
  const groups = {
    web: await bundled({
      entryPoints: ['src/web/main.ts', 'src/web/output.ts', 'src/web/phone.ts'],
      platform: 'browser',
      format: 'esm',
      loader: { '.css': 'empty', '.wasm': 'empty', '.png': 'empty', '.svg': 'empty' },
      // Vite's raw imports (the app's own documents) are text, not packages.
      external: ['*?raw'],
    }),
    desktop: await bundled({
      entryPoints: ['desktop/main.ts', 'desktop/preload.ts'],
      platform: 'node',
      format: 'cjs',
      external: ['electron', 'bufferutil', 'utf-8-validate'],
    }),
    bridge: [
      ...installed('ws').values(),
      ...installed('@modelcontextprotocol/sdk').values(),
      ...installed('zod').values(),
    ],
  };

  /** name@version → { name, version, license, homepage, dir, where: Set } */
  const pkgs = new Map();
  for (const [g, list] of Object.entries(groups))
    for (const { dir } of list) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const key = `${pkg.name}@${pkg.version}`;
      const e = pkgs.get(key) ?? {
        name: pkg.name,
        version: pkg.version,
        license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see below'),
        homepage:
          typeof pkg.repository === 'string'
            ? pkg.repository
            : (pkg.repository?.url ?? pkg.homepage ?? ''),
        dir,
        author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
        where: new Set(),
      };
      e.where.add(g);
      pkgs.set(key, e);
    }
  // Electron is the desktop app's runtime: not bundled, but shipped.
  {
    const dir = at('node_modules', 'electron');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkgs.set(`electron@${pkg.version}`, {
      name: 'electron',
      version: pkg.version,
      license: pkg.license,
      homepage: 'https://github.com/electron/electron',
      dir,
      where: new Set(['desktop']),
      note: 'Its own license files (LICENSE.electron.txt, and LICENSES.chromium.html for Chromium and the libraries in it) sit beside the app’s executable in every package, with this file and Mochi Studio’s LICENSE.mochi-studio.txt.',
    });
  }

  /** The full Apache-2.0 text, for packages that name the license without carrying it. */
  const apache = readFileSync(at('scripts', 'licenses', 'Apache-2.0.txt'), 'utf8').trim();

  const sorted = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const mochi2d = sorted.find((p) => p.name === 'mochi2d');
  if (!mochi2d) throw new Error('Mochi2D is not among the bundled packages.');

  const spout = JSON.parse(readFileSync(at('native', 'spout', 'sdk.json'), 'utf8'));

  const cell = (s) => String(s).replace(/\|/g, '\\|');
  let md = `# Third-party notices

Mochi Studio is licensed under the MIT License (\`LICENSE\`). It ships with
the third-party software below, each under its own license, whose text
follows. This file is written by \`npm run notices\` from what the build
bundles; a test checks that it is up to date.

- **The app's pages** (the browser app, and the pages inside the desktop
  app) bundle the packages marked "pages".
- **The desktop app** bundles the packages marked "desktop" into its main
  process (the bridge included), and runs on Electron.
- **The bridge,** installed from npm, installs the packages marked
  "bridge".
- **The sample model** «Mochi» (\`samples/mochi/\`, in the pages and the
  desktop app) is the example model of Mochi Maker's getting-started guide,
  made by Mochi Maker's own code, under the MIT License like Mochi Studio
  (\`samples/README.md\`).

| Package | Version | License | In |
| --- | --- | --- | --- |
${sorted
  .map(
    (p) =>
      `| ${cell(p.name)} | ${cell(p.version)} | ${cell(p.license)} | ${[...p.where]
        .map((w) => ({ web: 'pages', desktop: 'desktop', bridge: 'bridge' })[w])
        .join(', ')} |`,
  )
  .join('\n')}
| MediaPipe face and hand landmarker models | float16/1 | Apache-2.0 | pages (downloaded by \`npm run fetch:models\`) |
| Spout2 SDK (SpoutDX and the SpoutGL files it uses) | ${cell(spout.version)} (commit ${cell(spout.commit)}) | BSD-2-Clause | the Windows desktop app's Spout2 module |

`;

  for (const p of sorted) {
    const texts = licenseTexts(p.dir);
    md += `## ${p.name} ${p.version}\n\n`;
    md += `- **License:** ${p.license}\n`;
    if (p.homepage)
      md += `- **Source:** ${p.homepage.replace(/^git\+/, '').replace(/\.git$/, '')}\n`;
    md += `- **In:** ${[...p.where].map((w) => where[w]).join(', ')}\n`;
    if (p.note) md += `- ${p.note}\n`;
    if (EXTRA[p.name]) md += `- ${EXTRA[p.name]}\n`;
    md += '\n';
    if (texts.length) for (const t of texts) md += '```text\n' + t + '\n```\n\n';
    else if (p.license === 'MIT' || p.license === 'ISC') {
      // Named in package.json without a license file: the license's standard text, with the
      // copyright notice from the package's own sources.
      const holder = copyrightOf(p.dir) ?? `Copyright (c) ${p.author ?? p.name}`;
      md += `The package names the ${p.license} license without a license file; its text, with the copyright notice from the package's sources:\n\n`;
      md +=
        '```text\n' +
        readFileSync(at('scripts', 'licenses', `${p.license}.txt`), 'utf8')
          .trim()
          .replace('{copyright}', holder) +
        '\n```\n\n';
    } else if (p.license === 'Apache-2.0')
      md +=
        'The package names the Apache License 2.0 without carrying its text; it is under "Apache License 2.0" below.\n\n';
    else throw new Error(`${p.name} ${p.version} has no license file and is not Apache-2.0.`);
  }

  md += `## MediaPipe face and hand landmarker models

- **License:** Apache-2.0 (Google's MediaPipe model cards)
- **Source:** https://storage.googleapis.com/mediapipe-models/ (the
  \`face_landmarker\` and \`hand_landmarker\` float16 models, version 1)
- **In:** the app's pages, served from the app itself

The text is under "Apache License 2.0" below.

## Spout2 SDK ${spout.version}

- **License:** BSD-2-Clause
- **Source:** ${spout.repository} (commit ${spout.commit})
- **In:** compiled into the Spout2 module of the Windows desktop app

\`\`\`text
${readFileSync(at('native', 'spout', 'LICENSE.spout2.txt'), 'utf8').trim()}
\`\`\`

## Apache License 2.0

\`\`\`text
${apache}
\`\`\`

## Mochi2D's own notices

Mochi2D ${mochi2d.version} lists the third-party code it includes:

${readFileSync(join(mochi2d.dir, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  .replace(/\r\n/g, '\n')
  .trim()
  .replace(/^(#+) /gm, '$1## ')}
`;

  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(OUT)) ?? {};
  return prettier.format(md, { ...config, parser: 'markdown' });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const md = await notices();
  if (process.argv.includes('--check')) {
    const now = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (now !== md) {
      console.error('THIRD_PARTY_NOTICES.md is out of date: run npm run notices.');
      process.exit(1);
    }
    console.log('THIRD_PARTY_NOTICES.md is up to date.');
  } else {
    writeFileSync(OUT, md);
    console.log(`Wrote ${OUT}.`);
  }
}
