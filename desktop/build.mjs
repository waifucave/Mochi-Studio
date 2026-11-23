// Builds the desktop app into desktop/dist/app/: the Electron main process
// (bundled with the bridge) and the web pages. Run `npm run desktop:build`
// (after `vite build`), then `npm run desktop` or `npm run desktop:package`.
import { build } from 'esbuild';
import sharp from 'sharp';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
// fileURLToPath, not URL.pathname: the latter is wrong on Windows (/C:/…).
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here('./dist/app/');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [here('./main.ts')],
  outfile: join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
await build({
  entryPoints: [here('./preload.ts')],
  outfile: join(out, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
});
cpSync(here('../dist/'), join(out, 'web'), { recursive: true });
// The app's icon, from its one source (public/icon.svg): 1024 pixels for electron-builder, which
// makes the Windows .ico, the macOS .icns and the Linux icons from it, and 256 for the window.
const icon = here('../public/icon.svg');
mkdirSync(here('./dist/build'), { recursive: true });
await sharp(icon, { density: 288 }).resize(1024, 1024).png().toFile(here('./dist/build/icon.png'));
await sharp(icon, { density: 72 }).resize(256, 256).png().toFile(join(out, 'icon.png'));
// The app's license and the third-party notices, in every build (electron-builder also puts
// them beside the executable, with Electron's own license files).
cpSync(here('../LICENSE'), join(out, 'LICENSE'));
cpSync(here('../THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'));
// The Spout2 addon, when it was built (Windows: npm run fetch:spout, build:spout).
const spoutAddon = here('../native/spout/build/Release/mochi_spout.node');
if (existsSync(spoutAddon)) {
  mkdirSync(join(out, 'native'), { recursive: true });
  cpSync(spoutAddon, join(out, 'native', 'mochi_spout.node'));
  console.log('With the Spout2 addon.');
}
// The virtual camera's Linux module, when it was built (npm run build:v4l2).
const v4l2Addon = here('../native/v4l2/build/Release/mochi_v4l2.node');
if (existsSync(v4l2Addon)) {
  mkdirSync(join(out, 'native'), { recursive: true });
  cpSync(v4l2Addon, join(out, 'native', 'mochi_v4l2.node'));
  console.log('With the virtual camera module.');
}
// The virtual camera's Windows parts, when they were built (npm run build:wincam): the module,
// and the camera DLLs in native/x64/ and native/x86/ (unpacked: regsvr32 and other apps load them).
const wincam = here('../native/wincam/build/Release/');
if (existsSync(join(wincam, 'mochi_wincam.node'))) {
  mkdirSync(join(out, 'native'), { recursive: true });
  cpSync(join(wincam, 'mochi_wincam.node'), join(out, 'native', 'mochi_wincam.node'));
  for (const arch of ['x64', 'x86'])
    if (existsSync(join(wincam, arch)))
      cpSync(join(wincam, arch), join(out, 'native', arch), { recursive: true });
  console.log('With the Windows virtual camera.');
}
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'mochi-studio',
      productName: 'Mochi Studio',
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      author: 'Mochi Studio contributors',
      main: 'main.cjs',
    },
    null,
    2,
  ),
);
console.log(`Built the desktop app in ${out}`);
