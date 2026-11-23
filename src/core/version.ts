/**
 * Mochi Studio's version: package.json's, written here so every bundle has
 * it without reading package.json. The About, the bug report, the bridge
 * host's hello and the plugin API's answer take it from here; the bridge
 * has its own copy (BRIDGE_VERSION). test/unit/version.test.ts checks that
 * they and the packages' names agree with package.json.
 */
export const APP_VERSION = '0.1.0';

/** The project's public repository (package.json's homepage, without its #readme). */
export const REPOSITORY_URL = 'https://github.com/waifucave/Mochi-Studio';
