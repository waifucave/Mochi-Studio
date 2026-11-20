/**
 * The long soak run: `npm run soak -- --minutes 20
 * --stream-minutes 180 --heavy`. Builds the app first (`npm run build`).
 *
 * --minutes         real minutes to run (default 20)
 * --stream-minutes  stream minutes whose events are packed into them (default 180)
 * --heavy           the stream-sized synthetic model (test/support/heavyModel.ts)
 * --sample          seconds between memory samples (default 30)
 * --out FILE        writes the samples as JSON
 *
 * Prints memory over time in the window and the output view, and the growth
 * after the first sample.
 */
import { writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { heavyModelFiles } from '../test/support/heavyModel';
import { growth, runSoak } from '../test/support/soak';

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const minutes = Number(opt('minutes', '20'));
const streamMinutes = Number(opt('stream-minutes', '180'));
const heavy = args.includes('--heavy');
const out = opt('out', '');

const modelZip = heavy
  ? zipSync(
      Object.fromEntries(Object.entries(heavyModelFiles()).map(([p, b]) => [`heavy/${p}`, b])),
      { level: 0 },
    )
  : undefined;

const started = Date.now();
const r = await runSoak({
  minutes,
  streamMinutes,
  sampleEvery: Number(opt('sample', '30')),
  ...(modelZip ? { modelZip } : {}),
  log: (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)} s] ${m}`),
});
console.log('\nevents:', JSON.stringify(r.events));
console.log(
  'frames a second:',
  JSON.stringify(r.fps),
  'before the events:',
  JSON.stringify(r.baseFps),
);
console.log('growth after the first sample:');
console.log('  window:', JSON.stringify(growth(r.samples, 'window')));
console.log('  view:  ', JSON.stringify(growth(r.samples, 'view')));
console.log('errors:', r.errors.length ? r.errors : 'none');
if (out) writeFileSync(out, JSON.stringify({ minutes, streamMinutes, heavy, ...r }, null, 2));
process.exit(r.errors.length ? 1 : 0);
