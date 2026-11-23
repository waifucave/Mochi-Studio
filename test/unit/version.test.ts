import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIDGE_VERSION } from '../../bridge/src/server.ts';
import { APP_VERSION, REPOSITORY_URL } from '../../src/core/version';
import { aboutText } from '../../src/web/documents';
// @ts-expect-error: a plain JavaScript module, without types.
import { expectedFiles } from '../../scripts/release.mjs';

/**
 * One version everywhere: package.json's. Where each place gets it:
 *
 * - the app (the About, the bug report, the bridge host's hello, the
 *   plugin API's answer): src/core/version.ts;
 * - the bridge (its GET /, host_welcome, the MCP server's info):
 *   BRIDGE_VERSION in bridge/src/server.ts;
 * - the desktop app's own package.json, from which electron-builder takes
 *   the packages' names and the app's file properties (the Windows exe's
 *   version, the macOS app's Info.plist): desktop/build.mjs, from
 *   package.json;
 * - the Windows camera DLLs' file properties: native/wincam/CMakeLists.txt,
 *   from package.json; the macOS Camera Extension's Info.plist:
 *   native/maccam/build.sh, from package.json.
 *
 * The desktop workflow checks the built files' properties, and starts each
 * package to read its bridge's version.
 */
const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const version = JSON.parse(read('package.json')).version as string;

describe('the version', () => {
  it('is x.y.z', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is package.json's in the app and the bridge", () => {
    expect(APP_VERSION).toBe(version);
    expect(BRIDGE_VERSION).toBe(version);
  });

  it("is package-lock.json's", () => {
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
  });

  it("names package.json's repository in the About", () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.homepage).toBe(`${REPOSITORY_URL}#readme`);
    expect(pkg.repository.url).toBe(`git+${REPOSITORY_URL}.git`);
    expect(pkg.bugs.url).toBe(`${REPOSITORY_URL}/issues`);
    expect(
      aboutText({ version: APP_VERSION, desktop: false, repository: REPOSITORY_URL }),
    ).toContain(`${REPOSITORY_URL}/issues`);
  });

  it('is written nowhere else in the code that ships', () => {
    const literal = /['"`]\d+\.\d+\.\d+['"`]/;
    const allowed = new Set(['src/core/version.ts', 'bridge/src/server.ts']);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(new URL(dir, root))) {
        const p = join(dir, name);
        if (statSync(new URL(p, root)).isDirectory()) walk(p);
        else if (/\.(ts|mjs)$/.test(name) && !name.endsWith('.test.ts')) {
          const lines = read(p).split('\n');
          lines.forEach((l, i) => {
            if (!literal.test(l)) return;
            if (allowed.has(p) && /export const (APP|BRIDGE)_VERSION = /.test(l)) return;
            found.push(`${p}:${i + 1}: ${l.trim()}`);
          });
        }
      }
    };
    for (const d of ['src', 'bridge/src', 'desktop']) walk(d);
    expect(found).toEqual([]);
  });

  it("is in the desktop app's package.json, the packages' names and the native parts' properties", () => {
    expect(read('desktop/build.mjs')).toContain('version: pkg.version,');
    const builder = JSON.parse(read('desktop/electron-builder.json'));
    const arch = { linux: 'x86_64', win: 'x64', mac: 'arm64' } as const;
    const names = (['linux', 'win', 'mac'] as const).map((os) =>
      (builder[os].artifactName as string)
        .replace('${version}', version)
        .replace('${arch}', arch[os])
        .replace('${ext}', os === 'linux' ? 'AppImage' : 'zip'),
    );
    // The names the release job expects (scripts/release.mjs).
    expect(names).toEqual((expectedFiles(version) as string[]).slice(0, 3));
    // The macOS Camera Extension and the Windows camera DLLs read package.json themselves.
    expect(read('native/maccam/build.sh')).toContain(
      `VERSION=$(node -p "require('../../package.json').version")`,
    );
    const plist = read('native/maccam/Extension-Info.plist');
    expect(plist).toMatch(/CFBundleShortVersionString<\/key>\s*<string>@VERSION@/);
    expect(plist).toMatch(/CFBundleVersion<\/key>\s*<string>@VERSION@/);
    const cmake = read('native/wincam/CMakeLists.txt');
    expect(cmake).toContain('string(JSON MOCHI_VERSION GET ${MOCHI_PACKAGE} version)');
    expect(cmake.match(/mochi_version_rc\(mochi_camera_/g)).toHaveLength(2);
    const rc = read('native/wincam/src/version.rc.in');
    expect(rc).toContain('FILEVERSION @MOCHI_V1@,@MOCHI_V2@,@MOCHI_V3@,0');
    expect(rc).toContain('VALUE "ProductVersion", "@MOCHI_VERSION@"');
  });

  it("is in the agent docs' example and the About", () => {
    expect(read('docs/agent-api.md')).toContain(
      `"type": "host_hello", "protocol": 1, "app": "mochi-studio", "version": "${version}"`,
    );
    expect(
      aboutText({ version: APP_VERSION, desktop: true, repository: REPOSITORY_URL }).split('\n')[0],
    ).toBe(`Mochi Studio ${version}`);
  });
});
