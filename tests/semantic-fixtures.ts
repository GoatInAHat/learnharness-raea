import type { Expression, SemanticPlan } from "../src/semantic-math.ts";

export const x = { op: "x" } as const;
const c = (value: number): Expression => ({ op: "constant", value });
const add = (left: Expression, right: Expression): Expression => ({ op: "add", left, right });
const mul = (left: Expression, right: Expression): Expression => ({ op: "multiply", left, right });
const smooth = (input: Expression): Expression => ({ op: "smooth", input, steepness: 7 });

export const quadratic: SemanticPlan = {
  version: 3,
  title: "How a curve gets its slope",
  durationSeconds: 90,
  graph: {
    domain: [-2, 4],
    variable: "x",
    functionName: "f",
    xLabel: "Input",
    yLabel: "Function value",
    expression: add({ op: "power", base: x, exponent: 2 }, c(-1)),
  },
  beats: [
    { startFrame: 0, settleFrame: 0, cueFrame: 18, a: 1, h: 2, display: "function",
      camera: { x: 1, y: 5, width: 6.8, height: 16 }, narration: "Here is a curve we can measure." },
    { startFrame: 420, settleFrame: 450, cueFrame: 465, a: 1, h: 2, display: "points",
      camera: { x: 1, y: 5, width: 6.8, height: 16 }, narration: "Take two points on the curve." },
    { startFrame: 820, settleFrame: 850, cueFrame: 865, a: 1, h: 2, display: "secant",
      camera: { x: 1.6, y: 4.5, width: 4.6, height: 13 }, narration: "The slope of this secant comes from rise over run." },
    { startFrame: 1220, settleFrame: 1350, cueFrame: 1365, a: 1, h: 0.01, display: "limit",
      camera: { x: 1.006, y: 0.013, width: 0.12, height: 0.18 }, narration: "The interval shrinks, and the slope approaches two." },
    { startFrame: 1710, settleFrame: 1770, cueFrame: 1785, a: 1, h: 0, display: "tangent",
      camera: { x: 1, y: 0, width: 0.12, height: 0.18 }, narration: "The derivative is the slope of the tangent." },
    { startFrame: 2160, settleFrame: 2280, cueFrame: 2295, a: 1, h: 0, display: "compare", reference: -1,
      camera: { x: 0, y: 1, width: 4.6, height: 6.5 }, narration: "Move to another point and the tangent can slope the other way.",
      caption: "Different points can have different tangent slopes." },
  ],
};

export const joined: SemanticPlan = {
  ...quadratic,
  title: "A smooth join",
  graph: {
    ...quadratic.graph,
    expression: {
      op: "piecewise", at: 0,
      before: mul(c(4), smooth(add(mul(c(0.5), x), c(1)))),
      after: add(c(4), mul(c(4), smooth(mul(c(0.5), x)))),
    },
  },
  beats: quadratic.beats.map((beat) => ({ ...beat, camera: { x: 1, y: 4, width: 6.8, height: 10 } })),
};

/** A synthetic, cue-aligned PCM master for the comparison path. */
export function fixtureWav(plan: SemanticPlan = quadratic): Buffer {
  const rate = 16_000, bytes = Buffer.alloc(44 + plan.durationSeconds * rate * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (const beat of plan.beats) {
    const start = Math.round(beat.cueFrame * rate / 30);
    for (let i = 0; i < rate / 4; i++)
      bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * 880 / rate) * 3_000), 44 + (start + i) * 2);
  }
  return bytes;
}
