import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { rendererEnvironment } from "../src/pocket.ts";
import { createRuntime } from "../src/runtime.ts";
import { validTimeline } from "../src/timeline.ts";
import { timelineComposition } from "../src/timeline-render.ts";

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
const binary = path.join(root, "runtime", "v0.1.1-rc2", "raea", "bin", process.platform === "win32" ? "raea.exe" : "raea");
const artifacts = process.env.RAEA_QUALIFICATION_OUT || path.join(process.cwd(), "qualification-results");
const args = { env: rendererEnvironment(root, root), timeout: 30_000, signal };
const media = (...extra) => execute(binary, ["media", ...extra], args);
const inspect = async file => JSON.parse((await execute("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeout: 20_000, signal })).stdout);

async function diagnose(error) {
  await mkdir(artifacts, { recursive: true });
  const source = path.join(root, "diagnostic.tsx");
  const clip = path.join(artifacts, "diagnostic.mp4");
  const bounce = path.join(artifacts, "diagnostic-bounce.wav");
  await writeFile(source, timelineComposition(plan, { ...options, theme: "dark" }));
  try {
    const run = await execute(binary, ["render", source, "-o", clip], { timeout: 60_000, signal, env: { ...args.env, RAEA_AUDIO_BOUNCE: bounce } });
    await writeFile(path.join(artifacts, "diagnostics.json"), JSON.stringify({ productionError: String(error), renderer: run.stdout.slice(-4000), ffprobe: await inspect(clip), bounceLoudness: JSON.parse((await media("loudness", bounce)).stdout) }, null, 2) + "\n");
  } catch (diagnosticError) {
    await writeFile(path.join(artifacts, "diagnostics.txt"), `Production: ${error}\nDiagnostic: ${diagnosticError}\n`);
  }
}
try {
  assert(validTimeline(plan), "Qualification plan no longer matches the bounded schema");
  assert(runtime.asset, `Renderer unavailable on ${process.platform}/${process.arch}`);
  assert(!runtime.runtimeInstalled() && !runtime.pocketInstalled());
  await assert.rejects(runtime.render(plan, output, "dark", { runtime: false, speech: true }, signal, options), /runtime download needs your approval/i);
  await assert.rejects(runtime.render(plan, output, "dark", { runtime: true, speech: false }, signal, options), /narration model download needs your approval/i);
  assert(runtime.runtimeInstalled());
  assert(!runtime.pocketInstalled());

  const start = performance.now();
  try {
    await runtime.render(plan, output, "dark", { runtime: false, speech: true }, signal, options);
  } catch (error) {
    if (runtime.pocketInstalled()) await diagnose(error);
    throw error;
  }
  const modelSetupAndRenderSeconds = Math.round((performance.now() - start) / 100) / 10;
  assert(runtime.pocketInstalled());
  const bytes = await readFile(output);
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  await mkdir(artifacts, { recursive: true });
  await copyFile(output, path.join(artifacts, "secant-to-tangent.mp4"));

  const probe = await inspect(output);
  await writeFile(path.join(artifacts, "ffprobe.json"), JSON.stringify(probe, null, 2) + "\n");
  const video = probe.streams.find(stream => stream.codec_type === "video");
  const audio = probe.streams.find(stream => stream.codec_type === "audio");
  const duration = Number(probe.format.duration);
  assert.equal(video?.codec_name, "h264");
  assert.equal(video.width, 960);
  assert.equal(video.height, 540);
  assert(duration >= 17.9 && duration <= options.maxSeconds + 0.1);
  assert.equal(audio?.codec_name, "opus");
  assert(Number(audio.duration) >= duration - 0.2, "Embedded audio does not cover the video timeline");

  const require = createRequire(import.meta.url);
  const electron = require(path.join(process.cwd(), ".qualification-electron", "node_modules", "electron"));
  const playerScript = path.resolve("scripts/qualify-narrated-player.cjs");
  const player = await execute(electron, [...(process.platform === "linux" ? ["--no-sandbox"] : []), playerScript, output, root], { timeout: 35_000, signal });
  const playback = JSON.parse(player.stdout.trim());
  assert(playback.decodedPeak > 0.01 && playback.decodedPeak < 1);
  assert(playback.decodedSeconds >= duration - 0.2);
  assert(Math.abs(playback.seek - 9) < 0.1);

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
  const summary = { platform: `${process.platform}/${process.arch}`, modelSetupAndRenderSeconds, duration, width: video.width, height: video.height, codec: audio.codec_name, audioDuration: Number(audio.duration), ...playback, frames };
  await writeFile(path.join(artifacts, "metrics.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
