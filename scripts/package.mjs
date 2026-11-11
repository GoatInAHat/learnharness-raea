import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const target = path.resolve(process.argv[2] ?? "raea-explainer.zip");
const temp = await mkdtemp(path.join(tmpdir(), "raea-package-"));
try {
  const root = path.join(temp, "raea-explainer");
  await mkdir(root);
  await cp("dist", path.join(root, "dist"), { recursive: true });
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
    await cp(name, path.join(root, name));
  await rm(target, { force: true });
  const program = process.platform === "win32" ? "tar.exe" : "zip";
  const args =
    process.platform === "win32"
      ? ["-a", "-cf", target, "raea-explainer"]
      : ["-qr", target, "raea-explainer"];
  const result = spawnSync(program, args, {
    cwd: temp,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error("zip failed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
