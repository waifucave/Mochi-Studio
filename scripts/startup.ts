/**
 * Startup time: `npm run startup` (builds the app and
 * the desktop app first). With --desktop it also launches the desktop app
 * (on Linux under xvfb-run). With --small it uses the small synthetic model.
 *
 * Prints, per case, the median milliseconds from the launch (or the page's
 * navigation) to each step, up to the model on screen.
 */
import { heavyModelFiles } from '../test/support/heavyModel';
import { syntheticModelFiles } from '../test/support/syntheticModel';
import { browserStartup, desktopStartup, medians } from '../test/support/startup';

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1] ?? 3) || 3;
const small = args.includes('--small');
const files = small ? syntheticModelFiles({ name: 'test' }) : heavyModelFiles();
const modelFile = small ? 'test.model3.json' : 'heavy.model3.json';
console.log(`model: ${small ? 'small synthetic' : 'stream-sized synthetic'}, ${runs} runs`);
const b = await browserStartup(files, modelFile, runs);
console.log('browser, ms from navigation:', JSON.stringify(medians(b)));
if (args.includes('--desktop')) {
  const d = await desktopStartup(files, runs);
  console.log('desktop app, ms from launch:', JSON.stringify(medians(d)));
}
