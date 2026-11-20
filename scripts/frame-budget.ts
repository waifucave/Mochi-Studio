/**
 * The frame budget: `npm run frame-budget`, after
 * `npm run build`. Measures the stream-sized synthetic model
 * (test/support/heavyModel.ts) in the window alone, then with an output
 * view, and prints a CPU profile's hot spots.
 *
 * --seconds N   seconds measured per case (default 20)
 * --case C      alone, both or hidden (default: all three)
 * --small       the small synthetic model instead
 * --out FILE    writes the results as JSON
 */
import { writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { measureFrameBudget } from '../test/support/frameBudget';
import { heavyModelFiles } from '../test/support/heavyModel';
import { syntheticModelFiles } from '../test/support/syntheticModel';

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const seconds = Number(opt('seconds', '20'));
// --small: the small synthetic model, where drawing is cheap and the app's own share shows.
const small = args.includes('--small');
const modelZip = zipSync(
  Object.fromEntries(
    Object.entries(small ? syntheticModelFiles({ name: 'test' }) : heavyModelFiles()).map(
      ([p, b]) => [`model/${p}`, b],
    ),
  ),
  { level: 0 },
);
const log = (m: string) => console.log(m);
const only = opt('case', 'all');
const want = (c: string) => only === 'all' || only === c;
const results: Record<string, unknown> = {};
if (want('alone')) {
  const alone = await measureFrameBudget({ modelZip, seconds, profile: seconds, log });
  results.alone = alone;
  console.log('\nwindow alone:', JSON.stringify(alone.window));
  console.log('cpu (% of a core):', JSON.stringify(alone.cpu));
  console.log('hot spots (self ms over the run):');
  for (const h of alone.hot) console.log(`  ${String(h.selfMs).padStart(6)}  ${h.fn}  ${h.url}`);
}
if (want('both')) {
  const both = await measureFrameBudget({ modelZip, seconds, withView: true, log });
  results.both = both;
  console.log('\nwindow with an output view:', JSON.stringify(both.window));
  console.log('output view:', JSON.stringify(both.view));
  console.log('cpu (% of a core):', JSON.stringify(both.cpu));
}
if (want('hidden')) {
  // The usual stream: the control window minimized (hidden), OBS's view drawing.
  const hidden = await measureFrameBudget({ modelZip, seconds, withView: 'window hidden', log });
  results.hidden = hidden;
  console.log(`\nwindow hidden (${hidden.windowHidden}):`, JSON.stringify(hidden.window));
  console.log('output view:', JSON.stringify(hidden.view));
  console.log('cpu (% of a core):', JSON.stringify(hidden.cpu));
}
const out = opt('out', '');
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
