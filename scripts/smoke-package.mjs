// Starts a packaged desktop app and checks that it comes up: its bridge
// answers with package.json's version, and serves the app's pages (the
// window's and the output view's). Then stops it.
//
//   node scripts/smoke-package.mjs <executable> [args…]
//
// The desktop workflow runs it on each system's package (Linux under a
// virtual display). It uses its own port (MOCHI_STUDIO_PORT), so a bridge
// already running is not in the way.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [exe, ...args] = process.argv.slice(2);
if (!exe) {
  console.error('Usage: node scripts/smoke-package.mjs <executable> [args…]');
  process.exit(2);
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const port = Number(process.env.SMOKE_PORT ?? 47899);
const base = `http://127.0.0.1:${port}`;
const LIMIT_MS = 120_000;

const app = spawn(exe, args, {
  env: { ...process.env, MOCHI_STUDIO_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let output = '';
app.stdout.on('data', (d) => (output += d));
app.stderr.on('data', (d) => (output += d));
let exited = null;
app.on('exit', (code, signal) => (exited = { code, signal }));

/** Stops the app and everything it started: politely, then by force after 10 s. */
const stop = async () => {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(app.pid), '/t', '/f']);
    return;
  }
  const group = (signal) => {
    try {
      process.kill(-app.pid, signal);
    } catch {
      /* gone */
    }
  };
  group('SIGTERM');
  for (let i = 0; i < 100 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
  group('SIGKILL');
};
const fail = async (why) => {
  console.error(`::error::${why}`);
  console.error(`The app's output:\n${output.slice(-4000)}`);
  await stop();
  process.exit(1);
};

const t0 = Date.now();
let info;
while (!info) {
  if (exited) await fail(`The app exited (${JSON.stringify(exited)}) before its bridge answered.`);
  if (Date.now() - t0 > LIMIT_MS)
    await fail(`The app's bridge did not answer on ${base} in ${LIMIT_MS / 1000} s.`);
  try {
    const r = await fetch(`${base}/`);
    if (r.ok) info = await r.json();
  } catch {
    /* not listening yet */
  }
  if (!info) await new Promise((r) => setTimeout(r, 1000));
}
const s = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`The bridge answered after ${s} s: ${JSON.stringify(info)}`);
if (info.app !== 'mochi-studio-bridge')
  await fail(`The answer is from ${info.app}, not mochi-studio-bridge.`);
if (info.version !== version)
  await fail(`The bridge says version ${info.version}, package.json ${version}.`);
for (const page of ['/app/index.html', '/app/output.html']) {
  const r = await fetch(`${base}${page}`);
  const text = await r.text();
  if (!r.ok || !text.includes('<script')) await fail(`${page}: ${r.status}, ${text.length} bytes.`);
  console.log(`${page}: ${r.status}, ${text.length} bytes`);
}
// The window's page connects to its bridge as the host: then the app is up, not only its bridge.
const t1 = Date.now();
while (!info.studio?.connected) {
  if (Date.now() - t1 > LIMIT_MS)
    await fail(`The app's window did not connect to its bridge in ${LIMIT_MS / 1000} s.`);
  await new Promise((r) => setTimeout(r, 1000));
  info = await (await fetch(`${base}/`)).json();
}
console.log(`The window connected to its bridge after ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
console.log(`Mochi Studio ${version} started and answered.`);
await stop();
setTimeout(() => process.exit(0), 1000);
