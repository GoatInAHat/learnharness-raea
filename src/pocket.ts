import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import inventory from "./pocket-assets.json";
const files = inventory.groups.flatMap((group) => group.assets);
export const POCKET_MIB = Math.ceil(inventory.bytes / 1024 / 1024);
export const pocketRoot = (root: string) => path.join(root, "models");
export function pocketInstalled(root: string): boolean {
  try {
    const base = pocketRoot(root);
    if (fs.lstatSync(base).isSymbolicLink()) return false;
    const dir = path.join(base, "pocket-tts");
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    return files.every((f) => {
      const s = fs.lstatSync(path.join(dir, f.local));
      return s.isFile() && s.size === f.bytes;
    });
  } catch {
    return false;
  }
}
export async function verifyPocket(
  root: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!pocketInstalled(root)) return false;
  for (const entry of files) {
    signal.throwIfAborted();
    const file = path.join(pocketRoot(root), "pocket-tts", entry.local);
    const hash = createHash("sha256");
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stream = fs.createReadStream(file, { fd, autoClose: true });
    const abort = () => stream.destroy(new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of stream) hash.update(chunk as Buffer);
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (hash.digest("hex") !== entry.sha256) return false;
  }
  return true;
}
export async function installPocket(
  root: string,
  signal: AbortSignal,
  progress: (done: number, total: number) => void = () => {},
  repair = false,
): Promise<void> {
  if (pocketInstalled(root) && !repair) return;
  const base = pocketRoot(root);
  await fsp.mkdir(base, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(base).isSymbolicLink())
    throw new Error("Unsafe narration model directory");
  const stage = await fsp.mkdtemp(path.join(base, ".pocket-"));
  let total = 0;
  try {
    for (const entry of files) {
      signal.throwIfAborted();
      const response = await fetch(entry.url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Narration model download failed (${response.status})`);
      }
      const fd = await fsp.open(path.join(stage, entry.local), "wx", 0o600);
      const hash = createHash("sha256");
      let count = 0;
      try {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            count += value.length;
            total += value.length;
            if (count > entry.bytes)
              throw new Error("Narration model file exceeded expected size");
            hash.update(value);
            await fd.writeFile(value);
            progress(total, inventory.bytes);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      } finally {
        await fd.close();
      }
      if (count !== entry.bytes || hash.digest("hex") !== entry.sha256)
        throw new Error(`Narration model checksum failed: ${entry.local}`);
    }
    signal.throwIfAborted();
    const final = path.join(base, "pocket-tts");
    const backup = path.join(base, `.replaced-${path.basename(stage)}`);
    let moved = false;
    try {
      if (fs.existsSync(final)) {
        if (fs.lstatSync(final).isSymbolicLink())
          throw new Error("Unsafe narration model directory");
        fs.renameSync(final, backup);
        moved = true;
      }
      fs.renameSync(stage, final);
    } catch (error) {
      if (moved && !fs.existsSync(final)) fs.renameSync(backup, final);
      throw error;
    }
    if (moved) await fsp.rm(backup, { recursive: true, force: true });
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
  }
}
/** All Raea render and timing calls use a clean, offline, plugin-scoped environment. */
export function rendererEnvironment(
  root: string,
  work: string,
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    RAEA_OFFLINE: "1",
    HOME: work,
    TMPDIR: work,
    RAEA_NO_TREE: "1",
    RAEA_ENV_FILE: path.join(work, "env"),
    RAEA_CACHE: path.join(work, "cache"),
    RAEA_FEED_MODELS: pocketRoot(root),
    RAEA_SPEECH_CACHE: path.join(work, "speech-cache"),
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot || "C:\\Windows",
          TEMP: work,
          TMP: work,
          USERPROFILE: work,
        }
      : {}),
    ...((process.platform === "win32" || process.platform === "linux") &&
    process.env.WGPU_BACKEND === "vulkan"
      ? { WGPU_BACKEND: "vulkan" }
      : {}),
  };
}
