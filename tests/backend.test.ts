import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "../sdk/index.ts";
import { activate } from "../src/backend.ts";

test("tool admission, settings, saved videos, and bounded media", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "raea-test-"));
  try {
    const handlers = new Map<string, (input?: unknown) => unknown>();
    let factory: any;
    const instructions = new Set<string>();
    const ctx = {
      dataDirectory: directory,
      signal: new AbortController().signal,
      events: { emit() {} },
      handle(name: string, handler: (input?: unknown) => unknown) {
        handlers.set(name, handler);
      },
      registerInstructions(value: { agents: string[] }) {
        const agent = value.agents[0]!;
        instructions.add(agent);
        return () => {
          instructions.delete(agent);
        };
      },
      registerTools(x: any) {
        factory = x.create;
      },
    } as unknown as PluginBackendContext;
    const cleanup = activate(ctx);
    const call = (name: string, input?: unknown) =>
      handlers.get(name)!(input) as any;
    assert.deepEqual(call("settings"), {
      enabled: true,
      maxSeconds: 60,
      theme: "dark",
      narration: true,
      voice: "alba",
    });
    call("save-settings", { key: "maxSeconds", value: 10 });
    call("save-settings", { key: "theme", value: "light" });
    assert.deepEqual(call("settings"), {
      enabled: true,
      maxSeconds: 10,
      theme: "light",
      narration: true,
      voice: "alba",
    });
    assert.throws(
      () => call("save-settings", { key: "maxSeconds", value: 11 }),
      /Invalid/,
    );
    const tools = factory({ chatId: "chat-one", agent: "teacher" });
    if (!tools.length) return; // Unsupported CPU or OS.
    assert.ok(instructions.has("prober"));
    const plan = {
      version: 2,
      title: "Test",
      scenes: [1, 2].map(() => ({
        heading: "Step",
        caption: "Caption",
        narration: "A concise sentence.",
        seconds: 5,
        diagram: {
          kind: "equation",
          expression: "x = 2",
          annotation: "A value.",
        },
      })),
    };
    const a = await tools[0].execute(
      "call-one",
      plan,
      new AbortController().signal,
    );
    const b = await tools[0].execute(
      "call-one",
      plan,
      new AbortController().signal,
    );
    assert.equal(a.details.id, b.details.id);
    await assert.rejects(
      () =>
        tools[0].execute(
          "call-two",
          { ...plan, scenes: [...plan.scenes, plan.scenes[0]] },
          new AbortController().signal,
        ),
      /duration/,
    );
    call("save-settings", { key: "enabled", value: false });
    assert.equal(factory({ chatId: "chat-one", agent: "teacher" }).length, 0);
    assert.equal(instructions.has("prober"), false);
    call("save-settings", { key: "enabled", value: true });
    assert.ok(instructions.has("prober"));
    call("save-settings", { key: "enabled", value: false });
    assert.throws(
      () => call("start", { id: a.details.id, download: true }),
      /disabled/,
    );
    const recordPath = path.join(directory, "videos", a.details.id + ".json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.status = "done";
    writeFileSync(recordPath, JSON.stringify(record));
    assert.equal(call("status", { id: record.id }).status, "error");
    writeFileSync(
      path.join(directory, "videos", record.id + ".mp4"),
      Buffer.from("test video"),
    );
    assert.equal(call("status", { id: record.id }).status, "done");
    assert.equal(
      Buffer.from(
        call("chunk", { id: record.id, offset: 0 }).data,
        "base64",
      ).toString(),
      "test video",
    );
    assert.throws(() => call("chunk", { id: record.id, offset: 1 }), /offset/);
    assert.throws(() => call("chunk", { id: "../bad", offset: 0 }), /ID/);
    const future = JSON.stringify({
      version: 3,
      enabled: true,
      future: "preserve",
    });
    writeFileSync(path.join(directory, "settings.json"), future);
    assert.throws(
      () => call("save-settings", { key: "enabled", value: true }),
      /Unsupported/,
    );
    assert.equal(
      readFileSync(path.join(directory, "settings.json"), "utf8"),
      future,
    );
    await cleanup?.();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
