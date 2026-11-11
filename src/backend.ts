import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { PluginBackendContext } from "../sdk/index.ts";
import { videoSchema, validVideoPlan, type VideoPlan } from "./video.ts";
import { createRuntime } from "./runtime.ts";

type Settings = {
  enabled: boolean;
  maxSeconds: 10 | 15 | 25;
  theme: "dark" | "light";
};
type RecordData = {
  version: 1;
  id: string;
  chatId: string;
  plan: VideoPlan;
  status: "pending" | "running" | "done" | "error";
  error?: string;
};
const defaults: Settings = { enabled: true, maxSeconds: 25, theme: "dark" };
const idPattern = /^[a-f0-9-]{36}$/;
const chunkSize = 512 * 1024;
export function activate(ctx: PluginBackendContext) {
  fs.mkdirSync(ctx.dataDirectory, { recursive: true, mode: 0o700 });
  const root = ctx.dataDirectory,
    records = path.join(root, "videos"),
    settingsFile = path.join(root, "settings.json");
  fs.mkdirSync(records, { recursive: true, mode: 0o700 });
  const runtime = createRuntime(root);
  let running:
    | { id: string; controller: AbortController; finished: Promise<void> }
    | undefined;
  const atomic = (file: string, value: unknown) => {
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };
  const settings = (): Settings => {
    let raw: string;
    try {
      raw = fs.readFileSync(settingsFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...defaults };
      throw error;
    }
    const x = JSON.parse(raw);
    if (
      !x ||
      typeof x !== "object" ||
      (x.version !== undefined && x.version !== 1)
    )
      throw new Error("Unsupported video settings format");
    return {
      enabled: typeof x.enabled === "boolean" ? x.enabled : true,
      maxSeconds: [10, 15, 25].includes(x.maxSeconds) ? x.maxSeconds : 25,
      theme: x.theme === "light" ? "light" : "dark",
    };
  };
  let offProber: (() => void) | undefined;
  const updateProberInstructions = (enabled: boolean) => {
    if (enabled && runtime.asset && !offProber) {
      offProber = ctx.registerInstructions({
        agents: ["prober"],
        text: "If the learner asks for an explainer video, acknowledge the request and explain that the teacher can offer it during the teaching phase. Continue assessing their prior knowledge. Do not claim that the video has been created or rendered; the teacher handles it later.",
      });
    } else if ((!enabled || !runtime.asset) && offProber) {
      offProber();
      offProber = undefined;
    }
  };
  updateProberInstructions(settings().enabled);
  const file = (id: unknown, extension: string) => {
    if (typeof id !== "string" || !idPattern.test(id))
      throw new Error("Invalid video ID");
    return path.join(records, id + extension);
  };
  const usableMedia = (id: string) => {
    try {
      const stat = fs.lstatSync(file(id, ".mp4"));
      return stat.isFile() && stat.size > 0 && stat.size <= 25_000_000;
    } catch {
      return false;
    }
  };
  const read = (id: unknown): RecordData => {
    const item = JSON.parse(fs.readFileSync(file(id, ".json"), "utf8"));
    if (item.version !== 1 || item.id !== id || !validVideoPlan(item.plan))
      throw new Error("Invalid video record");
    return item;
  };
  const save = (item: RecordData) => {
    atomic(file(item.id, ".json"), item);
    ctx.events.emit("video-changed", { id: item.id });
  };
  const assertActive = () => {
    if (ctx.signal.aborted) throw new Error("Plugin disabled");
  };
  const start = (id: unknown, download: boolean) => {
    assertActive();
    const item = read(id);
    const pref = settings();
    if (!pref.enabled)
      throw new Error("New explainer videos are disabled in plugin settings.");
    if (!runtime.asset)
      throw new Error("Video rendering is unavailable on this platform.");
    if (!runtime.runtimeInstalled() && !download)
      throw new Error("Runtime download needs your approval.");
    if (running)
      throw new Error(
        "Another video is rendering; try again when it finishes.",
      );
    if (item.status === "done" && usableMedia(item.id)) return;
    fs.rmSync(file(item.id, ".mp4"), { force: true });
    const controller = new AbortController();
    item.status = "running";
    delete item.error;
    save(item);
    const active = { id: item.id, controller, finished: Promise.resolve() };
    running = active;
    active.finished = (async () => {
      try {
        await runtime.render(
          item.plan,
          file(item.id, ".mp4"),
          pref.theme,
          download,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        assertActive();
        item.status = "done";
        save(item);
      } catch (error) {
        fs.rmSync(file(item.id, ".mp4"), { force: true });
        item.status = "error";
        item.error = controller.signal.aborted
          ? "Cancelled"
          : error instanceof Error
            ? error.message
            : String(error);
        if (!ctx.signal.aborted) save(item);
      } finally {
        if (running?.controller === controller) running = undefined;
      }
    })().catch((error) => console.error("Raea video cleanup failed", error));
  };
  // Interrupted local work is not automatically replayed after a restart.
  for (const name of fs.readdirSync(records))
    if (/^[a-f0-9-]{36}\.json$/.test(name)) {
      try {
        const item = read(name.slice(0, -5));
        if (item.status === "running") {
          item.status = "error";
          item.error = "Rendering interrupted; retry to continue.";
          save(item);
        }
      } catch {
        /* Keep unknown/newer data untouched. */
      }
    }
  ctx.handle("settings", () => settings());
  ctx.handle("save-settings", (input) => {
    assertActive();
    if (!input || typeof input !== "object")
      throw new Error("Invalid settings");
    const x = input as { key?: unknown; value?: unknown };
    const pref = settings();
    if (x.key === "enabled" && typeof x.value === "boolean")
      pref.enabled = x.value;
    else if (x.key === "maxSeconds" && [10, 15, 25].includes(x.value as number))
      pref.maxSeconds = x.value as Settings["maxSeconds"];
    else if (x.key === "theme" && (x.value === "light" || x.value === "dark"))
      pref.theme = x.value;
    else throw new Error("Invalid settings");
    atomic(settingsFile, { version: 1, ...pref });
    updateProberInstructions(pref.enabled);
    ctx.events.emit("settings-changed", {});
    return pref;
  });
  ctx.handle("status", (input) => {
    const item = read((input as { id?: unknown })?.id);
    const mediaAvailable = usableMedia(item.id);
    return {
      ...item,
      status: item.status === "done" && !mediaAvailable ? "error" : item.status,
      error:
        item.status === "done" && !mediaAvailable
          ? "Saved video is missing; render it again."
          : item.error,
      enabled: settings().enabled,
      installed: runtime.runtimeInstalled(),
      platform: runtime.asset
        ? { downloadMiB: runtime.asset.downloadMiB, disk: runtime.asset.disk }
        : null,
    };
  });
  ctx.handle("start", (input) => {
    const x = input as { id?: unknown; download?: unknown };
    start(x?.id, x?.download === true);
    return { ok: true };
  });
  ctx.handle("cancel", (input) => {
    const x = input as { id?: unknown };
    read(x?.id);
    const active = running;
    if (active && active.id === x.id) active.controller.abort();
    return { ok: true };
  });
  ctx.handle("chunk", (input) => {
    const x = input as { id?: unknown; offset?: unknown };
    const item = read(x?.id);
    if (item.status !== "done") throw new Error("Video is not ready");
    if (
      !Number.isSafeInteger(x.offset) ||
      (x.offset as number) < 0 ||
      (x.offset as number) % chunkSize !== 0
    )
      throw new Error("Invalid video offset");
    const fd = fs.openSync(
      file(item.id, ".mp4"),
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size < 1 ||
        stat.size > 25_000_000 ||
        (x.offset as number) >= stat.size
      )
        throw new Error("Invalid video file");
      const buffer = Buffer.alloc(
        Math.min(chunkSize, stat.size - (x.offset as number)),
      );
      const n = fs.readSync(fd, buffer, 0, buffer.length, x.offset as number);
      return {
        data: buffer.subarray(0, n).toString("base64"),
        size: stat.size,
      };
    } finally {
      fs.closeSync(fd);
    }
  });
  ctx.registerInstructions({
    agents: ["teacher"],
    text: "When a learner requests a visual explainer and the Raea tool is available, use it to create a brief silent captioned video. Diagram coordinates are normalized: x/y are upper left, width/height are fractional canvas bounds. For sequences use separately positioned text for each item, coloring the compared item yellow, eliminated items red, and found items green. Keep the explanation and a quick comprehension check in the lesson.",
  });
  ctx.registerTools({
    agents: ["teacher"],
    create: (context) =>
      settings().enabled && runtime.asset
        ? [
            {
              name: "raea_explainer_video",
              label: "Explainer video",
              replay: "never",
              description: `Create a short silent explainer video from 2–5 scenes, at most ${settings().maxSeconds} seconds total. Use only when a video helps explain a concept or the learner asks for one. Supply meaningful heading, caption and diagram elements. Coordinates are normalized from 0 to 1 within the diagram area: x/y are the top-left of each box, width/height are its size. Text is left-aligned within its box, not stretched across it. For a list, put each value in a separate text element at explicit evenly spaced coordinates; use its text color to distinguish compared, discarded, kept or found values. Do not put an entire list in one text element or use separate highlight shapes with guessed positions. If using a shape behind a label, give both exactly the same box coordinates. Check every highlight covers only its intended values. Shapes paint behind text. Text and formulas are plain text. Rendering happens locally and may require learner approval for a one-time runtime download. Continue teaching; do not claim it has finished.`,
              parameters: videoSchema,
              execute: async (callId, input, signal) => {
                if (
                  signal?.aborted ||
                  ctx.signal.aborted ||
                  !settings().enabled
                )
                  throw new Error("Video creation is disabled or cancelled");
                if (
                  !validVideoPlan(input) ||
                  input.scenes.reduce((sum, scene) => sum + scene.seconds, 0) >
                    settings().maxSeconds
                )
                  throw new Error(
                    "Invalid plan or duration exceeds the configured maximum",
                  );
                const id = createHash("sha256")
                  .update(context.chatId + "\0" + callId)
                  .digest("hex")
                  .slice(0, 36);
                if (fs.existsSync(file(id, ".json")))
                  return {
                    content: [
                      { type: "text", text: "Video plan already saved." },
                    ],
                    details: { id },
                  };
                const item: RecordData = {
                  version: 1,
                  id,
                  chatId: context.chatId,
                  plan: input,
                  status: "pending",
                };
                save(item);
                if (runtime.runtimeInstalled() && !running) start(id, false);
                return {
                  content: [
                    {
                      type: "text",
                      text: "Video plan saved. The inline video card shows rendering or first-use setup.",
                    },
                  ],
                  details: { id },
                };
              },
            },
          ]
        : [],
  });
  return async () => {
    const active = running;
    active?.controller.abort();
    await active?.finished;
  };
}
