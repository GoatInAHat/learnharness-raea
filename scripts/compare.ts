import { constants } from "node:fs";
import { copyFile, link, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { maxWavBytes, readBoundedFile } from "../src/comparison-wav.ts";
import { createRuntime } from "../src/runtime.ts";
import { maxPlanBytes, parseSemanticPlan } from "../src/semantic-math.ts";

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      archive: { type: "string" },
      wav: { type: "string" },
      pocket: { type: "boolean" },
      "no-captions": { type: "boolean" },
    },
  });
  const [planFile, outputFile] = positionals;
  const extension = outputFile && path.extname(outputFile).toLowerCase();
  const pocketMaster = extension === ".wav" && !!values.pocket;
  if (positionals.length !== 2 || (extension !== ".mp4" && !pocketMaster) ||
    (values.wav && values.pocket)) {
    throw new Error("Usage: npm run compare -- PLAN.json OUTPUT.mp4 [--archive RAEA_ARCHIVE] [--wav MASTER.wav | --pocket] [--no-captions]\n" +
      "       npm run compare -- PLAN.json MASTER.wav --pocket [--archive RAEA_ARCHIVE]");
  }

  const plan = parseSemanticPlan((await readBoundedFile(planFile, maxPlanBytes)).toString("utf8"));
  const wav = values.wav ? await readBoundedFile(values.wav, maxWavBytes) : undefined;
  const directory = await realpath(path.dirname(outputFile));
  const output = path.join(directory, path.basename(outputFile));
  const root = await mkdtemp(path.join(directory, ".raea-comparison-"));
  const staged = path.join(root, "comparison" + extension);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await createRuntime(root, values.archive).render(
      plan, staged, "dark", { runtime: true, speech: !!values.pocket }, controller.signal,
      {
        wav, pocketMaster, narration: !!values.pocket, voice: "alba", maxSeconds: 120,
        captions: !values["no-captions"], progress: (message) => console.log(message),
      },
    );
    if (pocketMaster) await link(staged, output);
    else await copyFile(staged, output, constants.COPYFILE_EXCL);
    console.log(pocketMaster ? "Pocket PCM master exported." : "Comparison video rendered.");
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Comparison failed");
  process.exitCode = 1;
});
