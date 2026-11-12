import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "../sdk/index.ts";
import { activate } from "../src/backend.ts";
import { createRuntime } from "../src/runtime.ts";

test("confirmed repair is single-flight and blocks renders, even for structurally complete runtimes", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "raea-repair-flight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map<string, (input?: unknown) => unknown>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let repairCalls = 0;
  const runtime = {
    asset: { downloadMiB: 303, disk: "about 1.1 GiB installed" },
    runtimeInstalled: () => true,
    runtimeRepairRequired: () => false,
    runtimeUnsafe: () => false,
    pocketInstalled: () => true,
    check: async () => true,
    repair: async () => { repairCalls++; await gate; },
    render: async () => {},
    composition: () => "",
  } as unknown as ReturnType<typeof createRuntime>;
  const ctx = {
    dataDirectory: directory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle(name: string, handler: (input?: unknown) => unknown) { handlers.set(name, handler); },
    registerInstructions() { return () => {}; },
    registerTools() { return undefined; },
  } as unknown as PluginBackendContext;
  const cleanup = activate(ctx, (() => runtime) as typeof createRuntime);
  t.after(cleanup);
  const call = (name: string, input?: unknown) => handlers.get(name)!(input) as any;

  await assert.rejects(call("repair-runtime", { confirmed: false }), /explicit confirmation/);
  const first = call("repair-runtime", { confirmed: true });
  const second = call("repair-runtime", { confirmed: true });
  assert.equal(repairCalls, 1);
  await assert.rejects(call("start", { id: "unused" }), /repair is in progress/);
  release();
  await Promise.all([first, second]);
  assert.equal(repairCalls, 1);
});
