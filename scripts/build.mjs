import { build } from "esbuild";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
const dist = new URL("../dist/", import.meta.url);
try { if ((await lstat(dist)).isSymbolicLink()) throw new Error("Refusing symlinked dist"); } catch (error) { if (error.code !== "ENOENT") throw error; }
try { await lstat(new URL("data", dist)); throw new Error("Refusing dist/data"); } catch (error) { if (error.code !== "ENOENT") throw error; }
await rm(dist, { recursive: true, force: true }); await mkdir(dist, { recursive: true });
await build({ entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true, platform: "browser", format: "esm", target: "es2022" });
await build({ entryPoints: ["src/backend.ts"], outfile: "dist/backend.cjs", bundle: true, platform: "node", format: "cjs", target: "node22" });
await writeFile(new URL("manifest.json", dist), await readFile(new URL("../manifest.json", import.meta.url)));
