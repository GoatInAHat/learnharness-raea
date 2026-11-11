import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const temp = await mkdtemp(path.join(tmpdir(), "raea-check-"));
try {
  const archive = path.resolve("raea-explainer.zip");
  const program = process.platform === "win32" ? "tar.exe" : "unzip";
  const args =
    process.platform === "win32"
      ? ["-xf", archive, "-C", temp]
      : ["-q", archive, "-d", temp];
  const extracted = spawnSync(program, args, { stdio: "inherit" });
  if (extracted.error || extracted.status !== 0)
    throw extracted.error ?? new Error("Archive extraction failed");
  const plugin = path.join(temp, "raea-explainer");
  for (const name of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.txt",
    "dist/manifest.json",
    "dist/main.js",
    "dist/backend.cjs",
  ])
    assert.ok((await readFile(path.join(plugin, name))).length > 0);
  const plugins = path.join(temp, "plugins");
  await mkdir(plugins);
  const install = () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/install-plugin-local.mjs", plugins],
      { stdio: "inherit" },
    );
    if (result.error || result.status !== 0)
      throw result.error ?? new Error("Install failed");
  };
  install();
  const data = path.join(plugins, "raea-explainer", "data");
  await mkdir(data);
  await writeFile(path.join(data, "keep.txt"), "preserve");
  install();
  assert.equal(await readFile(path.join(data, "keep.txt"), "utf8"), "preserve");
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(plugins, "raea-explainer", "dist", "manifest.json"),
        "utf8",
      ),
    ).id,
    "raea-explainer",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
