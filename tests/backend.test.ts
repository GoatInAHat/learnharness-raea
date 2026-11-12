import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "../sdk/index.ts";
import { activate } from "../src/backend.ts";
import { quadratic } from "./semantic-fixtures.ts";

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
    const overlong = {
      ...plan,
      scenes: plan.scenes.map((scene) => ({
        ...scene,
        narration:
          "one two three four five six seven eight nine ten eleven twelve",
      })),
    };
    await assert.rejects(
      () =>
        tools[0].execute("overlong", overlong, new AbortController().signal),
      /length budget/,
    );
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
    assert.equal(tools.length, 1);
    call("save-settings", { key: "maxSeconds", value: 120 });
    const math = factory({ chatId: "chat-one", agent: "teacher" })
      .find((tool: { name: string }) => tool.name === "raea_semantic_math_video");
    assert.ok(math);
    const result = await math.execute("math", quadratic, new AbortController().signal);
    const id = result.details.id;
    const mathRecord = path.join(directory, "videos", id + ".json");
    const mathFile = path.join(directory, "videos", id + ".mp4");
    assert.deepEqual((await call("status", { id })).transcript, quadratic.beats.map((beat) => beat.narration));
    const completed = JSON.parse(readFileSync(mathRecord, "utf8"));
    writeFileSync(mathRecord, JSON.stringify({ ...completed, status: "done" }));
    writeFileSync(mathFile, "test video");
    truncateSync(mathFile, 25_000_001);
    assert.equal(call("chunk", { id, offset: 0 }).size, 25_000_001);
    truncateSync(mathFile, 50_000_001);
    assert.equal((await call("status", { id })).status, "error");

    call("save-settings", { key: "enabled", value: false });
    assert.equal(factory({ chatId: "chat-one", agent: "teacher" }).length, 0);
    assert.equal(instructions.has("prober"), false);
    call("save-settings", { key: "enabled", value: true });
    assert.ok(instructions.has("prober"));
    call("save-settings", { key: "enabled", value: false });
    await assert.rejects(
      () => call("start", { id: a.details.id, download: true }),
      /disabled/,
    );
    call("save-settings", { key: "enabled", value: true });
    mkdirSync(path.join(directory, "runtime", "v0.1.1-rc2"), { recursive: true });
    assert.equal((await call("status", { id: a.details.id })).repairRequired, true);
    await assert.rejects(
      () => call("start", { id: a.details.id, downloadRuntime: true }),
      /explicit Repair Raea runtime action/,
    );
    const recordPath = path.join(directory, "videos", a.details.id + ".json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.status = "done";
    writeFileSync(recordPath, JSON.stringify(record));
    assert.equal((await call("status", { id: record.id })).status, "error");
    writeFileSync(
      path.join(directory, "videos", record.id + ".mp4"),
      Buffer.from("test video"),
    );
    assert.equal((await call("status", { id: record.id })).status, "done");
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
