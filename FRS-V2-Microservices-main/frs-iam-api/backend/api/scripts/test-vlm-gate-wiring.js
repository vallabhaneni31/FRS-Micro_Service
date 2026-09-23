/**
 * test-vlm-gate-wiring.js — one-off manual check for the VLM quality-gate's
 * Node-side calling code (env.vlmQualityGate + the fetch/FormData/timeout
 * logic in vlmQualityGateService.js), without needing S3 configured.
 *
 * checkFrameUsable() normally fetches the image via storageService.getFileBuffer
 * (S3). This script reads a local file instead and posts it to the VLM
 * service the exact same way, to confirm the env config + HTTP plumbing work
 * end-to-end before wiring in real S3-backed visitor photos.
 *
 * Usage: node scripts/test-vlm-gate-wiring.js <path-to-image>
 */
import { readFile } from "fs/promises";
import { env } from "../src/config/env.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/test-vlm-gate-wiring.js <path-to-image>");
  process.exit(1);
}

console.log("env.vlmQualityGate:", env.vlmQualityGate);

const buffer = await readFile(filePath);
const form = new FormData();
form.append("image", new Blob([buffer], { type: "image/jpeg" }), "frame.jpg");

try {
  const res = await fetch(`${env.vlmQualityGate.baseUrl}/check-frame`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(env.vlmQualityGate.timeoutMs),
  });
  const data = await res.json();
  console.log("status:", res.status);
  console.log("body:", data);
} catch (err) {
  console.error("call failed:", err);
}
