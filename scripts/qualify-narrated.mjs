import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { rendererEnvironment } from "../src/pocket.ts";
import { createRuntime } from "../src/runtime.ts";
import { validTimeline } from "../src/timeline.ts";

const root = await mkdtemp(path.join(tmpdir(), "raea narrated qualification "));
const output = path.join(root, "secant-to-tangent.mp4");
const runtime = createRuntime(root);
const signal = AbortSignal.timeout(13 * 60_000);
const makeGraph = (other, formula) => ({ kind: "graph", curve: "quadratic", a: 1, b: 0, c: 0, point: 1, other, formula });
const plan = {
  version: 2,
  title: "From a secant to a tangent",
  scenes: [
    { heading: "Two points make a secant", caption: "The line passes through P and Q.", narration: "Two points make a secant. Keep the first point fixed.", seconds: 6, diagram: makeGraph(1.9, "f(x) = x²") },
    { heading: "Move Q closer to P", caption: "The rise and run shrink together.", narration: "Move the second point closer. The secant line turns as the gap shrinks.", seconds: 6, diagram: makeGraph(1.4, "slope = 2 + h") },
    { heading: "Reach the tangent", caption: "The limiting slope at P is two.", narration: "The limiting line is the tangent. Its slope at this point is two.", seconds: 6, diagram: makeGraph(1, "slope → 2") },
  ],
};
const options = { narration: true, voice: "alba", maxSeconds: 24 };
const execute = promisify(execFile);
try {
  assert(validTimeline(plan), "Qualification plan no longer matches the bounded schema");
  assert(runtime.asset, `Renderer unavailable on ${process.platform}/${process.arch}`);
  assert(!runtime.runtimeInstalled() && !runtime.pocketInstalled());
  await assert.rejects(runtime.render(plan, output, "dark", { runtime: false, speech: true }, signal, options), /runtime download needs your approval/i);
  await assert.rejects(runtime.render(plan, output, "dark", { runtime: true, speech: false }, signal, options), /narration model download needs your approval/i);
  assert(runtime.runtimeInstalled());
  assert(!runtime.pocketInstalled());

  const start = performance.now();
  await runtime.render(plan, output, "dark", { runtime: false, speech: true }, signal, options);
  const modelSetupAndRenderSeconds = Math.round((performance.now() - start) / 100) / 10;
  assert(runtime.pocketInstalled());
  const bytes = await readFile(output);
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  assert(bytes.includes(Buffer.from("mp4a")) && bytes.includes(Buffer.from("esds")), "Missing MPEG-4 audio sample description");

  const binary = path.join(root, "runtime", "v0.1.1-rc2", "raea", "bin", process.platform === "win32" ? "raea.exe" : "raea");
  const args = { env: rendererEnvironment(root, root), timeout: 30_000, signal };
  const media = (...extra) => execute(binary, ["media", ...extra], args);
  const probe = JSON.parse((await media("probe", output)).stdout);
  assert.equal(probe.video.codec, "h264");
  assert.equal(probe.video.width, 960);
  assert.equal(probe.video.height, 540);
  assert(probe.duration >= 17.9 && probe.duration <= options.maxSeconds + 0.1);
  assert(probe.audio?.duration >= probe.duration - 0.2, "Embedded audio does not cover the video timeline");
  const loudness = JSON.parse((await media("loudness", output)).stdout);
  assert(loudness.max_db > -45 && loudness.max_db <= 0, "Decoded narration is silent or clipped");

  const artifacts = process.env.RAEA_QUALIFICATION_OUT || path.join(process.cwd(), "qualification-results");
  await mkdir(artifacts, { recursive: true });
  const frames = [["secant", 2], ["approach", 9], ["tangent", 16]];
  const hashes = new Set();
  for (const [label, second] of frames) {
    const png = path.join(artifacts, `${label}.png`);
    await media("still", output, "--at", String(second), "-o", png);
    const image = await readFile(png);
    assert.equal(image.readUInt32BE(16), 960);
    assert.equal(image.readUInt32BE(20), 540);
    hashes.add(createHash("sha256").update(image).digest("hex"));
  }
  assert.equal(hashes.size, frames.length, "The sampled frames did not change");
  await copyFile(output, path.join(artifacts, "secant-to-tangent.mp4"));
  const summary = { platform: `${process.platform}/${process.arch}`, modelSetupAndRenderSeconds, duration: probe.duration, width: probe.video.width, height: probe.video.height, audioDuration: probe.audio.duration, peakDbfs: loudness.max_db, lufs: loudness.lufs, frames };
  await writeFile(path.join(artifacts, "metrics.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
