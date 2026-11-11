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
import { hasPlayableAudioTrack } from "./mp4-audio.ts";
import {
  installPocket,
  pocketInstalled,
  verifyPocket,
  rendererEnvironment,
} from "./pocket.ts";

export function createRuntime(root: string) {
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
  let modelInvalid = false;
  const pocketReady = () => !modelInvalid && pocketInstalled(root);
  const runtimeInstalled = () => {
    try {
      return (
        fs.lstatSync(binary).isFile() && !fs.lstatSync(runtime).isSymbolicLink()
      );
    } catch {
      return false;
    }
  };
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
  async function install(signal: AbortSignal): Promise<void> {
    if (runtimeInstalled()) return;
    if (!asset)
      throw new Error("Video rendering is not available on this platform.");
    await fsp.mkdir(path.dirname(runtime), { recursive: true });
    const stage = await fsp.mkdtemp(
      path.join(path.dirname(runtime), ".install-"),
    );
    const archive = path.join(stage, asset.archive);
    try {
      const response = await fetch(RELEASE + asset.archive, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Download failed (${response.status})`);
      }
      const file = await fsp.open(archive, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            size += chunk.length;
            if (size > asset.size)
              throw new Error("Runtime download exceeds expected size");
            hash.update(chunk);
            await file.writeFile(chunk);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
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
      await fsp.access(
        path.join(
          stage,
          "raea",
          "bin",
          process.platform === "win32" ? "raea.exe" : "raea",
        ),
      );
      signal.throwIfAborted();
      try {
        fs.renameSync(stage, runtime);
      } catch (error) {
        if (!runtimeInstalled()) throw error;
      }
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
    plan: VideoPlan | TimelinePlan,
    output: string,
    theme: "dark" | "light",
    consent: { runtime: boolean; speech: boolean },
    signal: AbortSignal,
    options: {
      narration: boolean;
      voice: "alba" | "marius";
      maxSeconds: number;
      progress?: (text: string) => void;
    },
  ) {
    if (!asset)
      throw new Error("Video rendering is not available on this platform.");
    if (!validVideoPlan(plan) && !validTimeline(plan))
      throw new Error("Invalid saved video plan.");
    if (!runtimeInstalled() && !consent.runtime)
      throw new Error("Runtime download needs your approval.");
    if (!runtimeInstalled()) {
      options.progress?.("Downloading Raea runtime…");
      await install(signal);
    }
    const narrated = validTimeline(plan) && options.narration;
    if (narrated && !pocketReady()) {
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
    if (narrated && !(await verifyPocket(root, signal))) {
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
      await fsp.writeFile(
        source,
        validTimeline(plan)
          ? timelineComposition(plan, {
              theme,
              narration: narrated,
              voice: options.voice,
              maxSeconds: options.maxSeconds,
            })
          : composition(plan, theme),
      );
      const env = rendererEnvironment(root, work);
      const bounce = path.join(work, "narration.wav");
      if (narrated && process.platform !== "darwin")
        env.RAEA_AUDIO_BOUNCE = bounce;
      await run(
        binary,
        ["render", source, "-o", tempOutput],
        work,
        AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
        env,
      );
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
        } else {
          const stat = await fsp.lstat(tempOutput);
          if (
            !stat.isFile() ||
            stat.size < 1 ||
            stat.size > 25_000_000 ||
            !hasPlayableAudioTrack(await fsp.readFile(tempOutput))
          )
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
        if (typeof loudness.max_db !== "number" || loudness.max_db < -70)
          throw new Error("Narration audio is silent.");
      }
      const stat = await fsp.lstat(tempOutput);
      if (!stat.isFile() || stat.size === 0 || stat.size > 25_000_000)
        throw new Error("Renderer did not produce a valid video file.");
      signal.throwIfAborted();
      fs.renameSync(tempOutput, output);
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }
  return {
    asset,
    runtimeInstalled,
    pocketInstalled: pocketReady,
    render,
    composition,
  };
}
