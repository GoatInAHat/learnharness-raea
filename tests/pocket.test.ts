import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installPocket, pocketInstalled } from "../src/pocket.ts";

test("model download aborts promptly and removes incomplete staging", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raea-model-test-"));
  const original = globalThis.fetch;
  let started!: () => void;
  const called = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (_url, options) => {
    const signal = options?.signal as AbortSignal;
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(new Error("aborted")),
            { once: true },
          );
          started();
        },
      }),
    );
  };
  try {
    const controller = new AbortController();
    const pending = installPocket(root, controller.signal);
    await called;
    controller.abort();
    await assert.rejects(pending);
    assert.equal(pocketInstalled(root), false);
    assert.deepEqual(fs.readdirSync(path.join(root, "models")), []);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid model response fails verification and cleans staging", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raea-model-test-"));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
  try {
    await assert.rejects(
      installPocket(root, new AbortController().signal),
      /checksum/i,
    );
    assert.equal(pocketInstalled(root), false);
    assert.deepEqual(fs.readdirSync(path.join(root, "models")), []);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
