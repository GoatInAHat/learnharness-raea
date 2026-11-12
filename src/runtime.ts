import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  videoRuntime,
  videoPaintOrder,
  validVideoPlan,
  type VideoPlan,
} from "./video.ts";
import { validTimeline, type TimelinePlan } from "./timeline.ts";
import { timelineComposition } from "./timeline-render.ts";
import { validSemanticPlan, type SemanticPlan } from "./semantic-math.ts";
import { semanticComposition } from "./semantic-render.ts";
import { maxWavBytes, readBoundedFile, validateComparisonWav } from "./comparison-wav.ts";
import { genericVideoBytes, hasPlayableAudioTrack, hasVideoPayload, semanticVideoBytes } from "./mp4-audio.ts";
import {
  installPocket,
  pocketInstalled,
  verifyPocket,
  rendererEnvironment,
} from "./pocket.ts";

export type RenderPlan = VideoPlan | TimelinePlan | SemanticPlan;
export const isSemantic = (plan: RenderPlan): plan is SemanticPlan =>
  !!plan && typeof plan === "object" && "version" in plan && plan.version === 3;
export const canNarrate = (plan: RenderPlan) => "version" in plan;
export const videoByteLimit = (plan: RenderPlan) =>
  isSemantic(plan) ? semanticVideoBytes : genericVideoBytes;

/** Files required by the pinned launcher to resolve its bundled SDK and target native bundle. */
export function runtimeCoreFiles(platform: string) {
  const binary = platform === "win32" ? "raea.exe" : "raea";
  const bundle = platform === "darwin" ? "libraea_bundle.dylib" :
    platform === "win32" ? "raea_bundle.dll" : "libraea_bundle.so";
  return [
    ["raea", "bin", binary],
    ["raea", "bin", bundle],
    ["raea", "share", "raea", "VERSION"],
    ["raea", "share", "raea", "sdk", "tsconfig.base.json"],
    ["raea", "share", "raea", "sdk", "raea", "src", "index.tsx"],
    ["raea", "share", "raea", "sdk", "raea", "src", "prelude.ts"],
    ["raea", "share", "raea", "sdk", "raea", "src", "asset.ts"],
    ["raea", "share", "raea", "sdk", "raea", "src", "image.ts"],
    ["raea", "share", "raea", "sdk", "raea", "src", "audio.ts"],
    ["raea", "share", "raea", "sdk", "audio", "src", "speech.tsx"],
    ["raea", "share", "raea", "sdk", "react", "js", "node_modules", "react", "package.json"],
  ] as const;
}

export function inspectRuntimeCore(
  runtime: string,
  coreFiles: readonly (readonly string[])[],
  expected: readonly (readonly [number, string])[],
  platform: string,
) {
  if (coreFiles.length !== expected.length) return;
  try {
    const files: Array<{ target: string; sha: string; key: string }> = [];
    for (const [index, parts] of coreFiles.entries()) {
      const [size, sha] = expected[index]!;
      if (!Number.isSafeInteger(size) || typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) return;
      let target = runtime;
      for (const part of parts.slice(0, -1)) {
        target = path.join(target, part);
        const dir = fs.lstatSync(target);
        if (dir.isSymbolicLink() || !dir.isDirectory()) return;
      }
      target = path.join(target, parts.at(-1)!);
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink() || !info.isFile() || info.size !== size) return;
      if (index === 0 && platform !== "win32") fs.accessSync(target, fs.constants.X_OK);
      files.push({ target, sha, key: [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, sha].join(":") });
    }
    return { files, key: files.map(file => file.key).join("|") };
  } catch { return; }
}

export async function promoteRuntime(
  runtime: string,
  stage: string,
  signal: AbortSignal,
  assertSafe: () => void,
  renameSync: typeof fs.renameSync = fs.renameSync,
) {
  const parent = path.dirname(runtime);
  const backup = await fsp.mkdtemp(path.join(parent, ".repair-"));
  const previous = path.join(backup, "previous");
  let preserveBackup = false;
  try {
    signal.throwIfAborted();
    assertSafe();
    if (fs.lstatSync(runtime, { throwIfNoEntry: false })) renameSync(runtime, previous);
    try {
      signal.throwIfAborted();
      assertSafe();
      renameSync(stage, runtime);
    } catch (error) {
      if (fs.lstatSync(previous, { throwIfNoEntry: false })) {
        try {
          assertSafe();
          if (fs.lstatSync(runtime, { throwIfNoEntry: false }))
            throw new Error("Runtime path changed during repair.");
          renameSync(previous, runtime);
        } catch {
          preserveBackup = true;
          throw new Error("Runtime repair failed; the previous runtime was preserved in its repair backup.");
        }
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) await fsp.rm(backup, { recursive: true, force: true });
  }
}

export function createRuntime(root: string, localArchive?: string) {
  const RELEASE =
    "https://github.com/shinyobjectz/raea/releases/download/v0.1.1-rc2/";
  const asset = videoRuntime(process.platform, process.arch);
  const runtime = path.join(root, "runtime", "v0.1.1-rc2");
  const binary = path.join(
    runtime,
    "raea",
    "bin",
    process.platform === "win32" ? "raea.exe" : "raea",
  );
  const coreFiles = runtimeCoreFiles(process.platform);
  const runtimeParent = path.join(root, "runtime");
  // The pinned Mac archive's core files let an existing install verify without
  // downloading again. Older Windows/Linux installs have no integrity record.
  const legacy = process.platform === "darwin" && process.arch === "arm64" ? [
    [706524048, "23a706c1c04d6fa8f896f7645a6990011ff1a1186a6b642bef5663aed82917db"],
    [29520664, "ea58d50ae5df456d8b8f994751ce0da2a5c23a4359c88d8decf9c52dee3e537f"],
    [10, "55421b4aa5ab908ce15be5586cefdc27a21cc99ff4771b1e216bb161f0a82671"],
    [5023, "cbada9a5c772d9f86ada6cf2e3367abbd4b16d590591ce93a5c87682e1482581"],
    [3648, "e8fbf14581322f5fd2e5c812d2b63e61aa51d72de96ba023d72c7e9fd1c6ad10"],
    [929, "212e8235d6b56a2e8cfc8b7e2861388b3204bd2e1634bea83c2de3f2d2db3b06"],
    [347, "5df502aa1106e9e4d182ac355c24776fcc399919e08a88f168fc4522e964fff5"],
    [503, "4b9f4986b105500fac7603366b64e93e850a5b40d7bea6b891a8cc6c43b84e46"],
    [587, "96b48ffd0196198eee8687bb32d5ae0beac92972993391443ad140c82b287ddd"],
    [6637, "2e18e77ad72c6b2c86b7b24236dce3038cdb6f3f3b41ed1c516ec9efb59e3750"],
    [1248, "6029fda5e660da53952cf5ddcd1e8568fc8dc0c6dcb9deaf7667fdc4c7f5a113"],
  ] as const : undefined;
  const markerName = "verified-runtime.json";
  let verified: { key: string; ok: boolean } | undefined;
  let modelInvalid = false;
  const pocketReady = () => !modelInvalid && pocketInstalled(root);
  function runtimePathHealth(): "missing" | "present" | "unsafe" {
    for (const directory of [root, runtimeParent, runtime]) {
      try {
        const info = fs.lstatSync(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) return "unsafe";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        return "unsafe";
      }
    }
    return "present";
  }
  function assertRuntimePathSafe() {
    if (runtimePathHealth() === "unsafe")
      throw new Error("Raea runtime path contains a symlink or non-directory; resolve it before repair.");
  }
  const runtimeStamp = () => {
    if (!asset) return;
    try {
      if (runtimePathHealth() !== "present") return;
      if (process.platform !== "win32") fs.accessSync(binary, fs.constants.X_OK);
      const marker = path.join(runtime, markerName);
      const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
      let expected = legacy;
      if (stat) {
        if (!stat.isFile() || stat.size > 2048) return;
        const data = JSON.parse(fs.readFileSync(marker, "utf8"));
        if (data?.archive !== asset.sha256) return;
        if (Array.isArray(data.files) && data.files.length === coreFiles.length) expected = data.files;
      }
      if (!expected) return;
      return inspectRuntimeCore(runtime, coreFiles, expected, process.platform);
    } catch { return; }
  };
  const runtimeInstalled = () => {
    const stamp = runtimeStamp();
    return !!stamp && !(verified?.key === stamp.key && !verified.ok);
  };
  const runtimeRepairRequired = () => runtimePathHealth() === "present" && !runtimeInstalled();
  const runtimeUnsafe = () => runtimePathHealth() === "unsafe";
  async function binaryDigest(file: string, signal: AbortSignal) {
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0) throw new Error("Invalid runtime executable.");
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ signal, autoClose: false })) hash.update(chunk);
      return { size: stat.size, sha: hash.digest("hex") };
    } finally { await handle.close(); }
  }
  async function verifyRuntime(signal: AbortSignal) {
    const stamp = runtimeStamp();
    if (!stamp) return false;
    if (verified?.key === stamp.key) return verified.ok;
    let ok = true;
    for (const file of stamp.files) {
      if ((await binaryDigest(file.target, signal)).sha !== file.sha) { ok = false; break; }
    }
    ok &&= runtimeStamp()?.key === stamp.key;
    verified = { key: stamp.key, ok };
    return ok;
  }
  function run(
    command: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let error = "",
        output = "";
      child.stdout?.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-12000);
      });
      let spawnError: Error | undefined;
      const abort = () => child.kill("SIGKILL");
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      child.stderr?.on("data", (chunk) => {
        error = (error + String(chunk)).slice(-2000);
      });
      child.on("error", (e) => {
        spawnError = e;
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(new Error("Cancelled or timed out"));
        else if (spawnError) reject(spawnError);
        else if (code === 0) resolve(output);
        else reject(new Error(`Renderer failed (${code}): ${error}`));
      });
    });
  }
  async function install(signal: AbortSignal, force = false): Promise<void> {
    if (!force && runtimeInstalled() && await verifyRuntime(signal)) return;
    if (!asset)
      throw new Error("Video rendering is not available on this platform.");
    assertRuntimePathSafe();
    await fsp.mkdir(path.dirname(runtime), { recursive: true });
    assertRuntimePathSafe();
    const stage = await fsp.mkdtemp(
      path.join(path.dirname(runtime), ".install-"),
    );
    const archive = path.join(stage, asset.archive);
    try {
      const archiveSignal = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (localArchive) {
          const input = await fsp.open(localArchive, fs.constants.O_RDONLY |
            (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
          try {
            const stat = await input.stat();
            if (!stat.isFile() || stat.size !== asset!.size)
              throw new Error("Runtime archive size mismatch");
            for await (const chunk of input.createReadStream({ signal: archiveSignal, autoClose: false }))
              yield chunk as Buffer;
          } finally {
            await input.close();
          }
          return;
        }
        const response = await fetch(RELEASE + asset!.archive, { signal: archiveSignal });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`Download failed (${response.status})`);
        }
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      const file = await fsp.open(archive, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of chunks()) {
          size += chunk.length;
          if (size > asset.size)
            throw new Error("Runtime download exceeds expected size");
          hash.update(chunk);
          await file.writeFile(chunk);
        }
      } finally {
        await file.close();
      }
      if (size !== asset.size || hash.digest("hex") !== asset.sha256)
        throw new Error("Runtime download checksum mismatch");
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const tar =
        process.platform === "win32"
          ? path.join(systemRoot, "System32", "tar.exe")
          : "/usr/bin/tar";
      const env =
        process.platform === "win32"
          ? { NODE_ENV: "production" as const, SystemRoot: systemRoot }
          : { NODE_ENV: "production" as const };
      await run(
        tar,
        [process.platform === "win32" ? "-xf" : "-xzf", archive, "-C", stage],
        stage,
        AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        env,
      );
      await fsp.rm(archive);
      const files = [];
      for (const parts of coreFiles) {
        const { size, sha } = await binaryDigest(path.join(stage, ...parts), signal);
        files.push([size, sha]);
      }
      await fsp.writeFile(path.join(stage, markerName), JSON.stringify({ archive: asset.sha256, files }),
        { flag: "wx", mode: 0o600 });
      signal.throwIfAborted();
      await promoteRuntime(runtime, stage, signal, assertRuntimePathSafe);
      verified = undefined;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  }
  function composition(
    plan: VideoPlan,
    theme: "dark" | "light" = "dark",
  ): string {
    // JSON is parsed as data, never interpolated as JSX or JavaScript source.
    const data = JSON.stringify(
      JSON.stringify({
        ...plan,
        scenes: plan.scenes.map((scene) => ({
          ...scene,
          drawOrder: videoPaintOrder(scene.elements),
        })),
      }),
    );
    const frames = Math.ceil(
      plan.scenes.reduce((n, scene) => n + scene.seconds, 0) * 24,
    );
    const palette =
      theme === "light"
        ? {
            background: "#f5f7fb",
            ink: "#142238",
            text: {
              blue: "#10498f",
              yellow: "#654900",
              white: "#142238",
              green: "#14532d",
              red: "#8b2029",
            },
            shape: {
              blue: "#c6def9",
              yellow: "#f4e2a8",
              white: "#d7e0ef",
              green: "#c6ebd2",
              red: "#f8d5d8",
            },
          }
        : {
            background: "#10162c",
            ink: "#f8f9ff",
            text: {
              blue: "#9bd1ff",
              yellow: "#ffe087",
              white: "#f8f9ff",
              green: "#a5efbd",
              red: "#ffb3b9",
            },
            shape: {
              blue: "#19416c",
              yellow: "#59410a",
              white: "#48536b",
              green: "#16512e",
              red: "#681f2b",
            },
          };
    return `import React from 'react';
import {AbsoluteFill,Composition,registerRoot,useCurrentFrame} from 'raea';
const plan=JSON.parse(${data});
const palette=${JSON.stringify(palette)};
function Scene(){const frame=useCurrentFrame(); let offset=0; let scene=plan.scenes[plan.scenes.length-1]; let local=0; for(const s of plan.scenes){local=frame-offset;offset+=s.seconds*24;if(frame<offset){scene=s;break;}}
return <AbsoluteFill style={{backgroundColor:palette.background,color:palette.ink,fontFamily:'sans-serif'}}><div style={{position:'absolute',left:40,top:25,fontSize:42,fontWeight:700}}>{scene.heading}</div>{scene.drawOrder.map(i=>{const e=scene.elements[i];return <div key={i} style={{position:'absolute',left:e.x*896,top:90+e.y*320,width:e.width*896,height:e.height*320,color:palette.text[e.color],backgroundColor:e.kind==='text'?'transparent':palette.shape[e.color],borderRadius:e.kind==='circle'?'50%':e.kind==='rect'?8:0,fontSize:28,overflow:'hidden',opacity:Math.min(1,Math.max(0,(local-i*(scene.seconds*24*.3/Math.max(1,scene.elements.length)))/8))}}>{e.kind==='text'?e.text:''}</div>})}<div style={{position:'absolute',left:40,bottom:24,fontSize:26}}>{scene.caption}</div></AbsoluteFill>}
registerRoot(()=> <Composition id="lesson" component={Scene} width={896} height={504} fps={24} durationInFrames={${frames}} />);`;
  }

  async function render(
    plan: RenderPlan,
    output: string,
    theme: "dark" | "light",
    consent: { runtime: boolean; speech: boolean },
    signal: AbortSignal,
    options: {
      narration: boolean;
      voice: "alba" | "marius";
      maxSeconds: number;
      wav?: Buffer;
      pocketMaster?: boolean;
      captions?: boolean;
      progress?: (text: string) => void;
    },
  ) {
    if (!asset)
      throw new Error("Video rendering is not available on this platform.");
    const semantic = isSemantic(plan);
    if (semantic ? !validSemanticPlan(plan) : !validVideoPlan(plan) && !validTimeline(plan))
      throw new Error("Invalid saved video plan.");
    if (semantic && plan.durationSeconds > options.maxSeconds)
      throw new Error("Video plan exceeds the selected maximum length.");
    if (options.pocketMaster && (!semantic || !options.narration || options.wav))
      throw new Error("A Pocket master requires a narrated semantic plan with local Pocket speech.");
    if (options.wav) {
      if (!semantic) throw new Error("Comparison WAV requires a semantic math plan.");
      validateComparisonWav(options.wav, plan);
    }
    const narrated = canNarrate(plan) && (options.narration || !!options.wav);
    const pocket = narrated && !options.wav;
    const maxBytes = videoByteLimit(plan);
    const verifiedRuntime = runtimeInstalled() && await verifyRuntime(signal);
    if (!verifiedRuntime && !consent.runtime)
      throw new Error(runtimeRepairRequired()
        ? "The pinned Raea runtime is damaged; use the explicit Repair Raea runtime action."
        : "Runtime download needs your approval.");
    if (!verifiedRuntime) {
      options.progress?.(localArchive ? "Verifying Raea runtime…" : "Downloading Raea runtime…");
      await install(signal);
    }
    if (pocket && !pocketReady()) {
      if (!consent.speech)
        throw new Error("Narration model download needs your approval.");
      let lastPercent = -1;
      await installPocket(
        root,
        signal,
        (done, total) => {
          const percent = Math.floor((done / total) * 100);
          if (percent !== lastPercent && !signal.aborted) {
            lastPercent = percent;
            options.progress?.(`Downloading narration model: ${percent}%`);
          }
        },
        modelInvalid,
      );
      modelInvalid = false;
    }
    if (pocket && !(await verifyPocket(root, signal))) {
      modelInvalid = true;
      throw new Error(
        "Narration model failed its integrity check. Download it again to repair.",
      );
    }
    options.progress?.("Rendering video…");
    signal.throwIfAborted();
    const work = await fsp.mkdtemp(path.join(root, "render-"));
    try {
      const source = path.join(work, "scene.tsx");
      const tempOutput = path.join(work, "video.mp4");
      if (semantic) {
        const edit = semanticComposition(plan, {
          theme, voice: options.voice, captions: options.captions,
          audio: options.wav ? "wav" : pocket ? "pocket" : "none",
        });
        const media = path.join(work, "media");
        await fsp.mkdir(media, { mode: 0o700 });
        for (const [id, svg] of Object.entries(edit.assets))
          await fsp.writeFile(path.join(media, id + ".svg"), svg, { mode: 0o600 });
        if (options.wav)
          await fsp.writeFile(path.join(media, "narration.wav"), options.wav, { mode: 0o600 });
        await fsp.writeFile(source, edit.source, { mode: 0o600 });
      } else {
        await fsp.writeFile(
          source,
          validTimeline(plan)
            ? timelineComposition(plan, { theme, narration: narrated, voice: options.voice, maxSeconds: options.maxSeconds })
            : composition(plan as VideoPlan, theme),
          { mode: 0o600 },
        );
      }
      const env = rendererEnvironment(root, work);
      const bounce = path.join(work, "narration.wav");
      if (options.pocketMaster || (narrated && process.platform !== "darwin"))
        env.RAEA_AUDIO_BOUNCE = bounce;
      await run(
        binary,
        ["render", source, "-o", tempOutput, ...(semantic ? ["--kbps", "2300"] : [])],
        work,
        AbortSignal.any([signal, AbortSignal.timeout(semantic ? 420_000 : 180_000)]),
        env,
      );
      const stat = await fsp.lstat(tempOutput);
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes)
        throw new Error("Renderer did not produce a valid video file.");
      if (semantic && options.pocketMaster) {
        const raw = await fsp.lstat(bounce);
        // The native mix can be stereo float PCM. Bound it before passing it to the decoder.
        if (!raw.isFile() || raw.size === 0 || raw.size > 4 * maxWavBytes)
          throw new Error("Renderer did not produce a bounded Pocket audio bounce.");
        const master = path.join(work, "master.wav");
        await run(binary, ["media", "audio", bounce, "--mono", "--rate", "48000", "-o", master],
          work, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), env);
        validateComparisonWav(await readBoundedFile(master, maxWavBytes), plan);
        signal.throwIfAborted();
        await fsp.chmod(master, 0o600);
        await fsp.link(master, output);
        return;
      }
      const bytes = await fsp.readFile(tempOutput);
      if (!hasVideoPayload(bytes)) throw new Error("Renderer did not produce a playable video.");
      if (narrated) {
        const audioFile = process.platform === "darwin" ? tempOutput : bounce;
        if (process.platform === "darwin") {
          const probe = JSON.parse(
            await run(
              binary,
              ["media", "probe", tempOutput],
              work,
              signal,
              env,
            ),
          );
          if (!probe.audio || !(probe.audio.duration > 0))
            throw new Error("Narration audio is missing from the video.");
        } else if (!hasPlayableAudioTrack(bytes, maxBytes)) {
          throw new Error("Narration audio track is missing from the video.");
        }
        const loudness = JSON.parse(
          await run(
            binary,
            ["media", "loudness", audioFile],
            work,
            signal,
            env,
          ),
        );
        if (!Number.isFinite(loudness.max_db) || loudness.max_db < -70)
          throw new Error("Narration audio is silent.");
      }
      signal.throwIfAborted();
      fs.renameSync(tempOutput, output);
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }
  return {
    asset,
    runtimeInstalled,
    runtimeRepairRequired,
    runtimeUnsafe,
    check(signal: AbortSignal) { return runtimeInstalled() && verifyRuntime(signal); },
    repair(signal: AbortSignal) { return install(signal, true); },
    pocketInstalled: pocketReady,
    render,
    composition,
  };
}
