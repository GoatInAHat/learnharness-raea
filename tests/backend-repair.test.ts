import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "../sdk/index.ts";
import { activate } from "../src/backend.ts";
import { createRuntime } from "../src/runtime.ts";
import { quadratic } from "./semantic-fixtures.ts";

test("confirmed repair is single-flight and blocks renders, even for structurally complete runtimes", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "raea-repair-flight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map<string, (input?: unknown) => unknown>();
  let createTools: ((context: { chatId: string; agent: string }) => any[]) | undefined;
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
    registerTools(options: { create(context: { chatId: string; agent: string }): any[] }) { createTools = options.create; },
  } as unknown as PluginBackendContext;
  const cleanup = activate(ctx, (() => runtime) as typeof createRuntime);
  t.after(cleanup);
  const call = (name: string, input?: unknown) => handlers.get(name)!(input) as any;

  await assert.rejects(call("repair-runtime", { confirmed: false }), /explicit confirmation/);
  const first = call("repair-runtime", { confirmed: true });
  const second = call("repair-runtime", { confirmed: true });
  assert.equal(repairCalls, 1);
  await assert.rejects(call("start", { id: "unused" }), /repair is in progress/);
  call("save-settings", { key: "maxSeconds", value: 120 });
  const tool = createTools!({ chatId: "repair-test", agent: "teacher" })
    .find((candidate: { name: string }) => candidate.name === "raea_semantic_math_video");
  const result = await tool.execute("new-plan-during-repair", quadratic, new AbortController().signal);
  assert.equal(call("status", { id: result.details.id }).status, "pending");
  const saved = JSON.parse(readFileSync(path.join(directory, "videos", result.details.id + ".json"), "utf8"));
  assert.equal(saved.status, "pending");
  release();
  await Promise.all([first, second]);
  assert.equal(repairCalls, 1);
});
