// Copies MediaPipe's Wasm files from node_modules into public/ so that the app
// serves them itself (no CDN at run time).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const to = resolve(root, 'public/mediapipe/wasm');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied MediaPipe wasm to ${to}`);
