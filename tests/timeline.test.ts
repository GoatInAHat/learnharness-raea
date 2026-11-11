import { test } from "node:test";
import assert from "node:assert/strict";
import { validTimeline } from "../src/timeline.ts";
import { rendererEnvironment } from "../src/pocket.ts";
import { timelineComposition } from "../src/timeline-render.ts";

const scene = {
  heading: "Slope",
  caption: "Move Q closer.",
  narration: "A secant becomes a tangent.",
  seconds: 5,
  diagram: {
    kind: "graph",
    curve: "quadratic",
    a: 1,
    b: 0,
    c: 0,
    point: 1,
    other: 1.5,
    formula: "slope = 2 + h",
  },
};
const plan = { version: 2, title: "Derivative", scenes: [scene, scene] };
test("semantic plans reject unsafe data and invalid interval indices", () => {
  assert.ok(validTimeline(plan));
  assert.equal(
    validTimeline({
      ...plan,
      scenes: [
        { ...scene, diagram: { ...scene.diagram, src: "file:///etc/passwd" } },
        scene,
      ],
    }),
    false,
  );
  assert.equal(
    validTimeline({
      ...plan,
      scenes: [{ ...scene, diagram: { ...scene.diagram, point: NaN } }, scene],
    }),
    false,
  );
  assert.equal(
    validTimeline({
      ...plan,
      scenes: [
        {
          ...scene,
          diagram: {
            kind: "interval",
            values: [1, 2],
            low: 0,
            high: 3,
            focus: 0,
            formula: "",
          },
        },
        scene,
      ],
    }),
    false,
  );
});
test("renderer uses a single clean offline environment without inherited credentials", () => {
  const env = rendererEnvironment("/private/plugin", "/private/job");
  assert.equal(env.RAEA_OFFLINE, "1");
  assert.equal(env.RAEA_FEED_MODELS, "/private/plugin/models");
  assert.equal(env.RAEA_SPEECH_CACHE, "/private/job/speech-cache");
  for (const key of [
    "HOME",
    "HF_TOKEN",
    "DEEPGRAM_API_KEY",
    "ANTHROPIC_API_KEY",
  ])
    assert.equal(env[key], undefined);
});
test("narration uses measured duration and preserves hostile text as inert JSON", () => {
  const hostile = {
    ...plan,
    title: "</script>${globalThis.nope}",
    scenes: [scene, scene],
  };
  assert.ok(validTimeline(hostile));
  const source = timelineComposition(hostile, {
    theme: "dark",
    narration: true,
    voice: "alba",
    maxSeconds: 60,
  });
  assert.match(source, /speechDuration/);
  assert.match(source, /seconds<=0/);
  assert.match(source, /frames>maxSeconds\*fps/);
  assert.match(source, /JSON\.parse/);
});

test("legacy silent plans remain valid after timeline upgrade", async () => {
  const { validVideoPlan } = await import("../src/video.ts");
  const legacy = {
    title: "Existing video",
    scenes: [1, 2].map(() => ({
      heading: "Step",
      caption: "Caption",
      seconds: 3,
      elements: [],
    })),
  };
  assert.equal(validVideoPlan(legacy), true);
});
