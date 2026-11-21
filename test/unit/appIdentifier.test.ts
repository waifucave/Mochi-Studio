import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The app's identifier and the names derived from it (docs/virtual-camera.md,
 * macOS): the app's ID, the Camera Extension's ID and bundle, the app group,
 * the extension's Mach service name and the queue label. They must agree
 * everywhere, or macOS won't activate the extension (its ID must begin with
 * the app's; the service name with the group).
 */
const read = (path: string) => readFileSync(path, 'utf8');
const builder = JSON.parse(read('desktop/electron-builder.json')) as {
  appId: string;
  mac: { extraFiles: { from: string; to: string }[] };
};
const APP = builder.appId;
const CAMERA = `${APP}.camera`;

describe('the app’s identifier and the names derived from it', () => {
  it('is com.waifucave.mochistudio', () => {
    expect(APP).toBe('com.waifucave.mochistudio');
  });

  it('names the Camera Extension, its bundle and the helper’s request after the app', () => {
    const bundle = `${CAMERA}.systemextension`;
    const ext = builder.mac.extraFiles.find((f) => f.from.endsWith('.systemextension'));
    expect(ext).toEqual({
      from: `../native/maccam/build/${bundle}`,
      to: `Library/SystemExtensions/${bundle}`,
    });
    const build = read('native/maccam/build.sh');
    expect(build).toContain(`\nID=${CAMERA}\n`);
    // The service name: the team prefix, then the extension's ID.
    expect(build).toContain('SERVICE="${MOCHI_TEAM_ID:+$MOCHI_TEAM_ID.}$ID"');
    // Info.plist takes the ID and the service name from build.sh.
    const info = read('native/maccam/Extension-Info.plist');
    expect(info).toMatch(/<key>CFBundleIdentifier<\/key>\s*<string>@ID@<\/string>/);
    expect(info).toMatch(/<key>CMIOExtensionMachServiceName<\/key>\s*<string>@SERVICE@<\/string>/);
    expect(read('native/maccam/Sources/MochiCameraHelper/main.swift')).toContain(
      `let extensionID = "${CAMERA}"`,
    );
    expect(read('native/maccam/Sources/MochiCameraExtension/main.swift')).toContain(
      `DispatchQueue(label: "${CAMERA}")`,
    );
  });

  it('puts the app and the extension in one group, the team-prefixed app ID, which the service name begins with', () => {
    const group = `TEAMID.${APP}`;
    for (const f of ['app', 'camera']) {
      const groups = [
        ...read(`native/maccam/entitlements/${f}.plist`).matchAll(/<string>([^<]+)<\/string>/g),
      ].map((m) => m[1]);
      expect(groups, f).toContain(group);
    }
    expect(`TEAMID.${CAMERA}`.startsWith(`${group}.`)).toBe(true);
  });

  it('is the one the docs give, and the previous one is gone', () => {
    const doc = read('docs/virtual-camera.md');
    expect(doc).toContain(`\`${APP}\``);
    expect(doc).toContain(`\`${CAMERA}\``);
    expect(doc).toContain(`\`<TeamID>.${APP}\``);
    expect(doc).toContain(`\`<TeamID>.${CAMERA}\``);
    // Nowhere outside the clean-room record (git grep finds nothing: status 1).
    const previous = ['org', 'mochistudio'].join('.');
    const r = spawnSync('git', ['grep', '-l', '-F', previous, '--', '.', ':!cleanroom'], {
      encoding: 'utf8',
    });
    expect(r.stdout.trim(), 'files still naming the old identifier').toBe('');
    expect(r.status).toBe(1);
  });
});
