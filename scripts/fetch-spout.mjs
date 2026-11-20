// Fetches the Spout2 SDK (BSD-2-Clause, github.com/leadedge/Spout2) at a
// pinned commit into native/spout/third_party/Spout2, for the Spout2 sender
// addon. Git checks the commit's content by its hash; the checkout is never
// committed. The pin is native/spout/sdk.json (THIRD_PARTY_NOTICES.md reads it
// too). Run: npm run fetch:spout (--force again).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = JSON.parse(readFileSync(resolve(root, 'native/spout/sdk.json'), 'utf8'));
const COMMIT = sdk.commit;
const REPO = `${sdk.repository}.git`;
const out = resolve(root, 'native/spout/third_party/Spout2');
const git = (...args) =>
  execFileSync('git', args, { cwd: out, stdio: ['ignore', 'pipe', 'inherit'] });

if (existsSync(resolve(out, 'SPOUTSDK')) && !process.argv.includes('--force')) {
  const head = git('rev-parse', 'HEAD').toString().trim();
  if (head === COMMIT) {
    console.log(`already present: ${out} (${COMMIT})`);
    process.exit(0);
  }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
git('init', '-q');
git('remote', 'add', 'origin', REPO);
git('fetch', '-q', '--depth', '1', 'origin', COMMIT);
git('checkout', '-q', 'FETCH_HEAD');
const head = git('rev-parse', 'HEAD').toString().trim();
if (head !== COMMIT) throw new Error(`Spout2 checkout is ${head}, expected ${COMMIT}`);
console.log(`Spout2 SDK ${COMMIT} in ${out}`);
