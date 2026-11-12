import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRuntimeCore, promoteRuntime, runtimeCoreFiles } from "../src/runtime.ts";
import { semanticComposition } from "../src/semantic-render.ts";
import { quadratic } from "./semantic-fixtures.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raea-runtime-integrity-"));
  const paths = runtimeCoreFiles(process.platform);
  const expected: Array<[number, string]> = [];
  for (const [index, parts] of paths.entries()) {
    const file = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `core-${index}`);
    expected.push([Buffer.byteLength(`core-${index}`), "a".repeat(64)]);
  }
  fs.chmodSync(path.join(root, ...paths[0]!), 0o700);
  return { root, paths, expected };
}

test("runtime core detects missing SDK, truncated bundle, and lost execute bit", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.ok(inspectRuntimeCore(f.root, f.paths, f.expected, process.platform));

  const sdk = path.join(f.root, ...f.paths.find((parts) => parts.some((part) => part === "tsconfig.base.json"))!);
  fs.rmSync(sdk);
  assert.equal(inspectRuntimeCore(f.root, f.paths, f.expected, process.platform), undefined);
  fs.writeFileSync(sdk, "core-3");

  const bundle = path.join(f.root, ...f.paths[1]!);
  fs.truncateSync(bundle, 1);
  assert.equal(inspectRuntimeCore(f.root, f.paths, f.expected, process.platform), undefined);
  fs.writeFileSync(bundle, "core-1");

  fs.chmodSync(path.join(f.root, ...f.paths[0]!), 0o600);
  assert.equal(inspectRuntimeCore(f.root, f.paths, f.expected, process.platform), undefined);
});

test("runtime core refuses symlinked SDK directories", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const sdk = path.join(f.root, "raea", "share", "raea", "sdk");
  const moved = sdk + ".saved";
  fs.renameSync(sdk, moved);
  fs.symlinkSync(moved, sdk, "dir");
  assert.equal(inspectRuntimeCore(f.root, f.paths, f.expected, process.platform), undefined);
});

test("runtime integrity paths select each platform launcher and native bundle", () => {
  assert.equal(runtimeCoreFiles("darwin")[0]![2], "raea");
  assert.equal(runtimeCoreFiles("darwin")[1]![2], "libraea_bundle.dylib");
  assert.equal(runtimeCoreFiles("linux")[1]![2], "libraea_bundle.so");
  assert.equal(runtimeCoreFiles("win32")[0]![2], "raea.exe");
  assert.equal(runtimeCoreFiles("win32")[1]![2], "raea_bundle.dll");
});

test("cancel before promotion preserves existing runtime and failed promotion rolls back", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raea-runtime-promote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  const stage = path.join(root, ".install-stage");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "old"), "keep");
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, "new"), "candidate");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(promoteRuntime(runtime, stage, aborted.signal, () => {}));
  assert.equal(fs.readFileSync(path.join(runtime, "old"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(stage, "new")), true);

  let checks = 0;
  const abortBeforeSecondRename = {
    throwIfAborted() {
      checks++;
      if (checks === 2) throw new Error("Cancelled");
    },
  } as AbortSignal;
  await assert.rejects(promoteRuntime(runtime, stage, abortBeforeSecondRename, () => {}), /Cancelled/);
  assert.equal(fs.readFileSync(path.join(runtime, "old"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(stage, "new")), true);

  let calls = 0;
  const rename = ((from: fs.PathLike, to: fs.PathLike) => {
    calls++;
    if (calls === 2) throw new Error("simulated promotion failure");
    fs.renameSync(from, to);
  }) as typeof fs.renameSync;
  await assert.rejects(promoteRuntime(runtime, stage, new AbortController().signal, () => {}, rename), /simulated promotion failure/);
  assert.equal(fs.readFileSync(path.join(runtime, "old"), "utf8"), "keep");
});

test("silent semantic template contains no audio JSX nodes", () => {
  const edit = semanticComposition(quadratic, { theme: "dark", audio: "none", voice: "alba" });
  assert.doesNotMatch(edit.source, /<(?:Audio|Mix|Speech)\b/);
});

test("bad local archive leaves prior runtime data untouched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raea-runtime-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime", "v0.1.1-rc2");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "existing-data"), "preserve me");
  const archive = path.join(root, "wrong-size.tar.gz");
  fs.writeFileSync(archive, "not the pinned archive");
  const { createRuntime } = await import("../src/runtime.ts");
  const instance = createRuntime(root, archive);
  const plan = { title: "Test", scenes: [1, 2].map(() => ({ heading: "Step", caption: "", seconds: 2, elements: [] })) };
  await assert.rejects(instance.render(plan, path.join(root, "out.mp4"), "dark", { runtime: true, speech: false }, new AbortController().signal,
    { narration: false, voice: "alba", maxSeconds: 10 }), /Runtime archive size mismatch/);
  assert.equal(fs.readFileSync(path.join(runtime, "existing-data"), "utf8"), "preserve me");
  assert.deepEqual(await fsp.readdir(path.join(root, "runtime")), ["v0.1.1-rc2"]);
});
