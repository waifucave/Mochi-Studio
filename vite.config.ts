import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** The sample model «Mochi» (samples/mochi/, unchanged), served at samples/mochi/. */
const SAMPLE = resolve(import.meta.dirname, 'samples/mochi');

/**
 * Puts the sample model beside the pages: copied into dist/samples/mochi/ by
 * the build (so the desktop app has it too), and served from samples/mochi/ by
 * the development server. "Try the sample model" loads it from there.
 */
function sampleModel(): Plugin {
  let outDir = 'dist';
  return {
    name: 'mochi-sample-model',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]!);
        const at = path.indexOf('/samples/mochi/');
        if (at < 0) return next();
        const file = resolve(SAMPLE, path.slice(at + '/samples/mochi/'.length));
        if (!file.startsWith(SAMPLE + sep) || !existsSync(file) || !statSync(file).isFile())
          return next();
        const json = ['.json'].includes(extname(file));
        res.setHeader('content-type', json ? 'application/json' : 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (existsSync(SAMPLE)) cpSync(SAMPLE, resolve(outDir, 'samples/mochi'), { recursive: true });
    },
  };
}

// Three pages: the control window (index.html), the clean output view for
// OBS (output.html) and the phone tracker's page (phone.html, served on the
// local network by the bridge, which finds its files in the manifest).
// Relative base so the build works from any sub-path.
export default defineConfig({
  base: './',
  plugins: [sampleModel()],
  build: {
    target: 'es2022',
    // At the top (not in .vite/), so packaged apps keep it.
    manifest: 'manifest.json',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        output: resolve(import.meta.dirname, 'output.html'),
        phone: resolve(import.meta.dirname, 'phone.html'),
      },
    },
  },
});
