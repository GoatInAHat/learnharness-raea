import assert from "node:assert/strict";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { Value } from "typebox/value";
import { validateComparisonWav } from "../src/comparison-wav.ts";
import { evaluate, parseSemanticPlan, semanticFrame, semanticSchema, validSemanticPlan, type Expression } from "../src/semantic-math.ts";
import { semanticComposition } from "../src/semantic-render.ts";
import { fixtureWav, joined, quadratic, x } from "./semantic-fixtures.ts";

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
  const negative = structuredClone(joined);
  for (const beat of negative.beats) beat.h = -beat.h;
  assert.ok(validSemanticPlan(negative));
  assert.equal(semanticFrame(negative, 1350).kind, "secant");
  assert.ok(semanticFrame(negative, 1350).q.x < semanticFrame(negative, 1350).p.x);
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

test("semantic composition uses local path-only math and measured per-beat audio", () => {
  const { source, assets } = semanticComposition(quadratic, { theme: "dark", audio: "pocket", voice: "alba" });
  assert.doesNotThrow(() => transformSync(source, { loader: "tsx" }));
  for (const id of ["difference", "secant", "limit", "tangent", "compare"]) {
    assert.match(assets[id], /<svg[^>]+viewBox=/);
    assert.match(assets[id], /<path /);
    assert.doesNotMatch(assets[id], /<text|<script|href=/);
  }
  assert.match(source, /speechDuration/);
  assert.match(source, /b\.cueFrame\+Math\.ceil\(duration\*fps\)>last-9/);
  assert.match(source, /start=\{beat.cueFrame\}/);
  assert.match(source, /Audio src=\{staticFile\('narration.wav'\)\}/);
});
