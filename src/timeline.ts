import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const bounded = (min: number, max: number) =>
  Type.Number({ minimum: min, maximum: max });
const graph = Type.Object(
  {
    kind: Type.Literal("graph"),
    curve: Type.Union([
      Type.Literal("quadratic"),
      Type.Literal("linear"),
      Type.Literal("sine"),
    ]),
    a: bounded(-2, 2),
    b: bounded(-2, 2),
    c: bounded(-2, 2),
    point: bounded(-2, 2),
    other: bounded(-2, 2),
    formula: Type.String({ maxLength: 65 }),
  },
  { additionalProperties: false },
);
const interval = Type.Object(
  {
    kind: Type.Literal("interval"),
    values: Type.Array(Type.Integer({ minimum: -999, maximum: 999 }), {
      minItems: 2,
      maxItems: 11,
    }),
    low: Type.Integer({ minimum: 0, maximum: 10 }),
    high: Type.Integer({ minimum: 0, maximum: 10 }),
    focus: Type.Integer({ minimum: 0, maximum: 10 }),
    formula: Type.String({ maxLength: 65 }),
  },
  { additionalProperties: false },
);
const vector = Type.Object(
  {
    kind: Type.Literal("vector"),
    x: bounded(-3, 3),
    y: bounded(-3, 3),
    label: Type.String({ maxLength: 50 }),
    formula: Type.String({ maxLength: 65 }),
  },
  { additionalProperties: false },
);
const equation = Type.Object(
  {
    kind: Type.Literal("equation"),
    expression: Type.String({ minLength: 1, maxLength: 65 }),
    annotation: Type.String({ maxLength: 100 }),
  },
  { additionalProperties: false },
);
export const timelineSchema = Type.Object(
  {
    version: Type.Literal(2),
    title: Type.String({ minLength: 1, maxLength: 100 }),
    scenes: Type.Array(
      Type.Object(
        {
          heading: Type.String({ minLength: 1, maxLength: 80 }),
          caption: Type.String({ maxLength: 140 }),
          narration: Type.String({ minLength: 1, maxLength: 240 }),
          seconds: bounded(2, 20),
          diagram: Type.Union([graph, interval, vector, equation]),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);
export type TimelinePlan = Static<typeof timelineSchema>;
export function validTimeline(value: unknown): value is TimelinePlan {
  return (
    Value.Check(timelineSchema, value) &&
    value.scenes.every((s) => {
      if (!Number.isFinite(s.seconds)) return false;
      const d = s.diagram;
      if (d.kind === "graph")
        return [d.a, d.b, d.c, d.point, d.other].every(Number.isFinite);
      if (d.kind === "vector") return [d.x, d.y].every(Number.isFinite);
      if (d.kind === "interval")
        return (
          d.values.every(Number.isFinite) &&
          d.low <= d.high &&
          d.high < d.values.length &&
          d.focus < d.values.length &&
          d.values.every((n, i) => i === 0 || d.values[i - 1]! <= n)
        );
      return true;
    })
  );
}

/** Reserve room for pauses and use a conservative speech rate for model guidance. */
export function narrationWordLimit(
  maxSeconds: number,
  sceneCount: number,
): number {
  return Math.max(
    1,
    Math.floor(Math.max(0, maxSeconds - sceneCount * 1.65) * 1.5),
  );
}
export function narrationWordCount(plan: TimelinePlan): number {
  return plan.scenes.reduce(
    (sum, scene) =>
      sum + scene.narration.trim().split(/\s+/u).filter(Boolean).length,
    0,
  );
}
