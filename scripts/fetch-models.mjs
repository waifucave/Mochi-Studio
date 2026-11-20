// Downloads MediaPipe's face and hand landmarker models (Apache-2.0) into
// public/ so the app can serve them locally. Run once: npm run fetch:models
// (`node scripts/fetch-models.mjs face` or `hand` fetches one; --force again).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const name of asked.length ? asked : Object.keys(MODELS)) {
  const url = MODELS[name];
  if (!url) throw new Error(`unknown model "${name}" (face or hand)`);
  const out = resolve(root, `public/mediapipe/${name}_landmarker.task`);
  if (existsSync(out) && !process.argv.includes('--force')) {
    console.log(`already present: ${out}`);
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${name}): ${res.status}`);
  writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
  console.log(`saved ${out}`);
}
