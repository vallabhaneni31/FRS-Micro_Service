#!/usr/bin/env node
/**
 * Copies the MediaPipe vision WASM runtime out of node_modules and fetches the
 * Face Landmarker model bundle into public/mediapipe/, so the enrollment
 * portal can load them same-origin instead of from a CDN.
 *
 * These are ~26 MB of binaries, so they are gitignored and regenerated here
 * rather than committed (same approach as the Python service's InsightFace /
 * MediaPipe weights). Runs automatically via the `prebuild` npm script.
 */

import { existsSync, mkdirSync, copyFileSync, statSync, createWriteStream } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { get } from 'https';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const WASM_SRC = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const WASM_DEST = resolve(root, 'public/mediapipe/wasm');
const MODEL_DEST = resolve(root, 'public/mediapipe/models');

// Both variants ship: FilesetResolver picks the SIMD build where the browser
// supports it and silently falls back to the nosimd one where it does not.
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const MODEL_FILE = 'face_landmarker.task';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

function download(url, dest) {
  return new Promise((resolvePromise, reject) => {
    const request = (target) =>
      get(target, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${target} -> HTTP ${res.statusCode}`));
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolvePromise));
        file.on('error', reject);
      }).on('error', reject);
    request(url);
  });
}

async function main() {
  if (!existsSync(WASM_SRC)) {
    console.error(
      '[mediapipe] @mediapipe/tasks-vision is not installed — run `npm install` first.'
    );
    process.exit(1);
  }

  mkdirSync(WASM_DEST, { recursive: true });
  mkdirSync(MODEL_DEST, { recursive: true });

  for (const name of WASM_FILES) {
    const from = resolve(WASM_SRC, name);
    const to = resolve(WASM_DEST, name);
    if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
    copyFileSync(from, to);
    console.log(`[mediapipe] copied ${name}`);
  }

  const modelPath = resolve(MODEL_DEST, MODEL_FILE);
  if (!existsSync(modelPath) || statSync(modelPath).size === 0) {
    console.log(`[mediapipe] downloading ${MODEL_FILE} …`);
    await download(MODEL_URL, modelPath);
    console.log(`[mediapipe] downloaded ${MODEL_FILE}`);
  }

  console.log('[mediapipe] assets ready in public/mediapipe/');
}

main().catch((err) => {
  console.error('[mediapipe] asset sync failed:', err.message);
  process.exit(1);
});
