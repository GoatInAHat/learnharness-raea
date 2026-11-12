import assert from "node:assert/strict";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { Value } from "typebox/value";
import { validateComparisonWav } from "../src/comparison-wav.ts";
import { evaluate, narrationWindow, parseSemanticPlan, semanticFrame, semanticSchema, validSemanticPlan, type Expression } from "../src/semantic-math.ts";
import { semanticComposition } from "../src/semantic-render.ts";
import { fixtureWav, joined, quadratic, x } from "./semantic-fixtures.ts";

test("comparison drops both tangent readouts at a coincident transition frame", () => {
  const plan = structuredClone(quadratic);
  const camera = { x: 0, y: 1, width: 6, height: 6 };
  Object.assign(plan.beats[4], { display: "compare", reference: 0, camera });
  Object.assign(plan.beats[5], { display: "tangent", a: -1, camera });
  delete plan.beats[5].reference;
  assert(validSemanticPlan(plan));
  assert.equal(semanticFrame(plan, 2219).display, "compare");
  const exact = semanticFrame(plan, 2220);
  assert.equal(exact.p.x, 0);
  assert.equal(exact.display, "points");
  assert.equal(exact.reference, undefined);
  assert.equal(semanticFrame(plan, 2221).display, "compare");
});

test("v3 shares bounded geometry across camera motion and exact tangent states", () => {
  assert.ok(validSemanticPlan(quadratic));
  assert.ok(Value.Check(semanticSchema, quadratic));
  assert.deepEqual(parseSemanticPlan(JSON.stringify(quadratic)), quadratic);
  assert.deepEqual(evaluate(quadratic.graph.expression, -2), [3, -4]);

  const wide = semanticFrame(quadratic, 1220);
  const mid = semanticFrame(quadratic, 1285);
  const close = semanticFrame(quadratic, 1350);
  assert.equal(wide.h, 2);
  assert.equal(mid.h, 1.005);
  assert.ok(Math.abs(mid.camera.width - Math.sqrt(wide.camera.width * close.camera.width)) < 1e-12);
  assert.equal(mid.display, "secant");
  assert.equal(close.display, "limit");
  assert.equal(close.cueFrame, 1365);
  assert.equal(close.kind, "secant");
  assert.ok(Math.abs(close.slope - 2.01) < 1e-10);
  assert.notEqual(close.q.x, close.p.x);

  const finalSecant = semanticFrame(quadratic, 1769);
  assert.equal(finalSecant.kind, "secant");
  assert.ok(finalSecant.h > 0 && finalSecant.q.x > finalSecant.p.x);
  const tangent = semanticFrame(quadratic, 1770);
  assert.equal(tangent.kind, "tangent");
  assert.deepEqual(tangent.q, tangent.p);
  assert.equal(tangent.slope, 2);
  assert.equal(tangent.display, "tangent");
  assert.deepEqual(semanticFrame(quadratic, 2280).reference, { x: -1, y: 0, slope: -2 });
});

test("joined logistic curve evaluates and differentiates analytically on both branches", () => {
  assert.ok(validSemanticPlan(joined));
  const expr = joined.graph.expression;
  const sigmoid = (n: number) => 1 / (1 + Math.exp(-n));
  const expected = 14 * sigmoid(-3.5) * sigmoid(3.5) / (1 - 2 * sigmoid(-3.5));
  assert.equal(evaluate(expr, -2)[0], 0);
  assert.equal(evaluate(expr, 0)[0], 4);
  assert.equal(evaluate(expr, 2)[0], 8);
  assert.ok(Math.abs(evaluate(expr, 0)[1] - expected) < 1e-13);
  assert.ok(Math.abs(evaluate(expr, -1e-8)[1] - expected) < 1e-7);
  const tangentPlan = structuredClone(joined);
  const tangent = tangentPlan.beats[4];
  tangent.a = 0;
  const exact = semanticFrame(tangentPlan, tangent.settleFrame);
  assert.equal(exact.kind, "tangent");
  assert.deepEqual(exact.p, exact.q);
  for (const h of [-1e-13, 1e-13]) {
    Object.assign(tangent, { h, display: "secant" });
    const secant = semanticFrame(tangentPlan, tangent.settleFrame);
    assert.equal(secant.kind, "secant");
    assert.equal(secant.q.x, h);
    assert.ok(Math.abs(secant.slope - expected) < 1e-12);
  }
  const negative = structuredClone(joined);
  for (const beat of negative.beats) beat.h = -beat.h;
  assert.ok(validSemanticPlan(negative));
  assert.equal(semanticFrame(negative, 1350).kind, "secant");
  assert.ok(semanticFrame(negative, 1350).q.x < semanticFrame(negative, 1350).p.x);
});

test("piecewise joins reject a representable jump or kink before producing a tangent", () => {
  for (const after of [
    { op: "add", left: x, right: { op: "constant", value: 1e-9 } },
    { op: "multiply", left: x, right: { op: "constant", value: 1.000000001 } },
  ] as const) {
    const plan = structuredClone(joined);
    plan.graph.expression = { op: "piecewise", at: 0, before: x, after };
    const tangent = plan.beats[4];
    tangent.a = 0;
    assert.equal(validSemanticPlan(plan), false);
    assert.throws(() => semanticFrame(plan, tangent.settleFrame), /must match/);
  }
});

test("smooth endpoints are exact and the tails stay analytic", () => {
  const smooth = { op: "smooth", input: x, steepness: 10 } as const;
  const [lo, dlo] = evaluate(smooth, 0);
  const [hi, dhi] = evaluate(smooth, 1);
  assert.equal(lo, 0);
  assert.equal(hi, 1);
  assert.equal(dlo, dhi);
  const [below, dbelow] = evaluate(smooth, -0.2);
  const [above, dabove] = evaluate(smooth, 1.2);
  assert.ok(below < 0 && above > 1 && dbelow > 0 && dabove > 0);
  const plan = structuredClone(joined);
  assert.equal(validSemanticPlan({
    ...plan, graph: { ...plan.graph, expression: { op: "clamp", input: x, min: 0, max: 1 } },
  }), false);
});

test("frame geometry admits the closed domain and rejects off-domain points", () => {
  const plan = structuredClone(quadratic);
  const beat = plan.beats[0];
  Object.assign(beat, { a: -2, h: 6, camera: { x: 1, y: 5, width: 8, height: 24 } });
  assert.ok(validSemanticPlan(plan));
  const edge = semanticFrame(plan, 0);
  assert.equal(edge.p.x, -2);
  assert.equal(edge.q.x, 4);
  for (const [a, h] of [[-2.01, 1], [-2, -0.01], [1, 3.01]]) {
    Object.assign(beat, { a, h });
    assert.equal(validSemanticPlan(plan), false);
    assert.throws(() => semanticFrame(plan, 0), /within the graph domain/);
  }
  plan.graph.domain = [-2, 0.11];
  plan.graph.expression = x;
  for (const keyframe of plan.beats) Object.assign(keyframe, {
    a: 0.1, h: keyframe.h === 0 ? 0 : 0.01,
    camera: { x: 0, y: 0, width: 4, height: 4 },
  });
  assert.ok(validSemanticPlan(plan));
  assert.equal(semanticFrame(plan, plan.beats[1].startFrame + 2).q.x, 0.11);
});

test("a small rise retains its secant slope across a large offset", () => {
  const plan = structuredClone(quadratic);
  plan.graph.expression = {
    op: "add", left: { op: "constant", value: 500 },
    right: {
      op: "multiply", left: { op: "constant", value: 1e-10 },
      right: { op: "power", base: x, exponent: 2 },
    },
  };
  for (const beat of plan.beats) beat.camera.y = 500;
  assert.ok(validSemanticPlan(plan));
  const frame = semanticFrame(plan, 1769);
  assert.equal(frame.kind, "secant");
  assert.equal(frame.p.y, frame.q.y);
  assert.ok(Math.abs(frame.slope - (2 + frame.h) * 1e-10) < 1e-23);
});

test("v3 rejects malformed data, unbounded ASTs, and mismatched semantic timing", () => {
  const bad = structuredClone(joined);
  const expr = bad.graph.expression;
  assert.equal(expr.op, "piecewise");
  if (expr.op === "piecewise") expr.after = x;
  assert.equal(validSemanticPlan(bad), false);

  let deep: Expression = x;
  for (let i = 0; i < 9; i++) deep = { op: "power", base: deep, exponent: 1 };
  assert.equal(validSemanticPlan({ ...quadratic, graph: { ...quadratic.graph, expression: deep } }), false);
  for (const change of [
    { h: 0 }, { h: 0.00001 }, { h: -0.01 }, { cueFrame: 1354 },
    { camera: { x: 99, y: 99, width: 0.1, height: 0.1 } },
    { narration: "<script>globalThis.bad()</script>" }, { code: "while(true){}" },
  ]) {
    const plan = structuredClone(quadratic);
    Object.assign(plan.beats[3], change);
    assert.equal(validSemanticPlan(plan), false);
  }
  assert.throws(() => parseSemanticPlan(" ".repeat(65537)), /64 KiB/);
});

test("process cues require visible motion and preserve the later settled cue", () => {
  const plan = structuredClone(quadratic);
  const beat = plan.beats[3];
  Object.assign(beat, {
    settleFrame: 1520, cueFrame: 1508, narrationScope: "process",
    narration: "Watch the moving point approach the fixed point.",
  });
  assert.ok(Value.Check(semanticSchema, plan));
  assert.deepEqual(parseSemanticPlan(JSON.stringify(plan)), plan);
  const cue = semanticFrame(plan, beat.cueFrame);
  assert.equal(cue.narrationScope, "process");
  assert.equal(cue.display, "secant");
  assert.equal(cue.kind, "secant");
  assert.ok(cue.h > beat.h && cue.h < plan.beats[2].h);
  assert.equal(semanticFrame(plan, beat.settleFrame).display, "limit");
  assert.equal(semanticFrame(plan, plan.beats[4].cueFrame).narrationScope, "settled");
  assert.deepEqual(narrationWindow(plan, 3), { cueFrame: 1508, speechEndFrame: 1701 });

  for (const change of [
    { narrationScope: "moving" }, { narrationScope: "settled" },
    { cueFrame: beat.startFrame }, { cueFrame: beat.settleFrame - 11 },
    { cueFrame: beat.settleFrame }, { settleFrame: beat.startFrame + 301 },
    { a: plan.beats[2].a, h: plan.beats[2].h, camera: plan.beats[2].camera },
  ]) {
    const invalid = structuredClone(plan);
    Object.assign(invalid.beats[3], change);
    assert.equal(validSemanticPlan(invalid), false, JSON.stringify(change));
  }
  const overlap = structuredClone(plan);
  overlap.beats[4].startFrame = beat.settleFrame;
  assert.equal(validSemanticPlan(overlap), false);
  const initial = structuredClone(plan);
  initial.beats[0].narrationScope = "process";
  assert.equal(validSemanticPlan(initial), false);
  const hidden = structuredClone(plan);
  hidden.beats[2].display = "function";
  hidden.beats[3].camera = hidden.beats[2].camera;
  assert.equal(validSemanticPlan(hidden), false);

  const hold = plan.beats[4];
  Object.assign(hold, {
    settleFrame: hold.startFrame, cueFrame: hold.startFrame + 12, narrationScope: "settled",
    h: beat.h, camera: beat.camera, display: beat.display,
  });
  assert.ok(validSemanticPlan(plan));
  hold.cueFrame--;
  assert.equal(validSemanticPlan(plan), false);
});

test("comparison WAV admits aligned PCM and rejects silence, truncation, and early audio", () => {
  const wav = fixtureWav();
  assert.doesNotThrow(() => validateComparisonWav(wav, quadratic));
  assert.throws(() => validateComparisonWav(wav.subarray(0, -2), quadratic), /PCM/);
  const early = Buffer.from(wav);
  early.writeInt16LE(3000, 44);
  assert.throws(() => validateComparisonWav(early, quadratic), /outside/);
  wav.fill(0, 44);
  assert.throws(() => validateComparisonWav(wav, quadratic), /silent at beat 1/);
});

test("the PCM window starts at the authored process cue", () => {
  const plan = structuredClone(quadratic);
  Object.assign(plan.beats[3], { cueFrame: 1240, narrationScope: "process" });
  assert.ok(validSemanticPlan(plan));
  const wav = fixtureWav(plan);
  assert.doesNotThrow(() => validateComparisonWav(wav, plan));
  assert.throws(() => validateComparisonWav(wav, quadratic), /outside/);
});

test("semantic composition uses local path-only math and measured per-beat audio", () => {
  const { source, assets } = semanticComposition(quadratic, { theme: "dark", audio: "pocket", voice: "alba" });
  assert.doesNotThrow(() => transformSync(source, { loader: "tsx" }));
  for (const id of ["difference", "secant", "limit", "tangent", "compare"]) {
    assert.match(assets[id], /<svg[^>]+viewBox=/);
    assert.match(assets[id], /<path /);
    assert.doesNotMatch(assets[id], /<text|<script|href=/);
  }
  assert.match(source, /speechDuration/);
  assert.match(source, /b\.cueFrame\+Math\.ceil\(duration\*fps\)>b\.speechEndFrame/);
  assert.match(source, /start=\{beat.cueFrame\}/);
  assert.match(source, /Audio src=\{staticFile\('narration.wav'\)\}/);
  assert.match(source, /width=\{1920\} height=\{1080\}/);
  assert.match(source, /<svg width=\{pxSize\(W\)\} height=\{pxSize\(H\)\} viewBox=/);
  assert.match(source, /tangent\?'Q = P'.*pointX===otherX\?'a \+ h':otherX/);
});
