import { Type } from "typebox";
import Schema from "typebox/schema";
import jsonSchema from "./semantic-math.schema.json";

export type Expression =
  | { op: "constant"; value: number }
  | { op: "x" }
  | { op: "add" | "subtract" | "multiply"; left: Expression; right: Expression }
  | { op: "power"; base: Expression; exponent: number }
  | { op: "smooth"; input: Expression; steepness: number }
  | { op: "piecewise"; at: number; before: Expression; after: Expression };
export type Display = "function" | "points" | "difference" | "secant" | "limit" | "tangent" | "compare";
type Camera = { x: number; y: number; width: number; height: number };
type Beat = {
  startFrame: number;
  settleFrame: number;
  cueFrame: number;
  a: number;
  h: number;
  camera: Camera;
  display: Display;
  reference?: number;
  narrationScope?: "settled" | "process";
  narration: string;
  caption?: string;
};
export type SemanticPlan = {
  version: 3;
  title: string;
  durationSeconds: number;
  graph: {
    domain: [number, number];
    variable: string;
    functionName: string;
    xLabel: string;
    yLabel: string;
    slopeUnit?: string;
    expression: Expression;
  };
  beats: Beat[];
};

const { $schema, ...toolSchema } = jsonSchema;
export const semanticSchema = Type.Unsafe<SemanticPlan>(toolSchema);
export const semanticFps = 30;
export const maxPlanBytes = 64 * 1024;
const magnitude = (n: number) => Number.isFinite(n) && Math.abs(n) <= 1e6;
const plain = (s: string) =>
  s.trim().length > 0 && !/[\p{Cc}\p{Cf}]|<\/?[a-z!]/iu.test(s);

export function parseSemanticPlan(json: string): SemanticPlan {
  if (Buffer.byteLength(json) > maxPlanBytes) throw new Error("Plan exceeds 64 KiB");
  const plan: unknown = JSON.parse(json);
  if (!validSemanticPlan(plan)) throw new Error("Invalid semantic math plan");
  return plan;
}

/** Bound the walk before asking the recursive schema to validate it. */
function boundedExpression(value: unknown): boolean {
  let count = 0;
  function visit(node: unknown, depth: number): boolean {
    if (!node || typeof node !== "object" || ++count > 64 || depth > 8) return false;
    const x = node as Record<string, unknown>;
    switch (x.op) {
      case "constant":
      case "x":
        return true;
      case "add":
      case "subtract":
      case "multiply":
        return visit(x.left, depth + 1) && visit(x.right, depth + 1);
      case "power":
        return visit(x.base, depth + 1);
      case "smooth":
        return visit(x.input, depth + 1);
      case "piecewise":
        return depth === 1 && visit(x.before, 2) && visit(x.after, 2);
      default:
        return false;
    }
  }
  return visit(value, 1);
}

function sigmoid(x: number) {
  const e = Math.exp(-Math.abs(x));
  return (x < 0 ? e : 1) / (1 + e);
}

/** Evaluate the curve and its first derivative together by the chain rule. */
export function evaluate(expression: Expression, x: number): [number, number] {
  switch (expression.op) {
    case "constant": return [expression.value, 0];
    case "x": return [x, 1];
    case "piecewise": {
      const { at, before, after } = expression;
      if (x < at) return evaluate(before, x);
      const right = evaluate(after, x);
      if (x === at) {
        const left = evaluate(before, x);
        if (!right.every((value, i) => Number.isFinite(value) && value === left[i]))
          throw new Error("Piecewise value and first derivative must match at the breakpoint");
      }
      return right;
    }
    case "power": {
      const [value, derivative] = evaluate(expression.base, x);
      const { exponent } = expression;
      return [value ** exponent, exponent * value ** (exponent - 1) * derivative];
    }
    case "smooth": {
      const [value, derivative] = evaluate(expression.input, x);
      const k = expression.steepness;
      const offset = sigmoid(-k / 2);
      const z = k * (value - 0.5);
      const scale = 1 - 2 * offset;
      const tail = sigmoid(-Math.abs(z));
      const normalized = value === 0 ? 0 : value === 1 ? 1 : (sigmoid(z) - offset) / scale;
      return [normalized, k * (tail * (1 - tail)) * derivative / scale];
    }
    default: {
      const [left, dl] = evaluate(expression.left, x);
      const [right, dr] = evaluate(expression.right, x);
      if (expression.op === "add") return [left + right, dl + dr];
      if (expression.op === "subtract") return [left - right, dl - dr];
      return [left * right, dl * right + left * dr];
    }
  }
}

// Compute a small rise without subtracting rounded function values near a large baseline.
function smallRise(expression: Expression, a: number, h: number): number {
  if (h === 0) return 0;
  const b = a + h;
  switch (expression.op) {
    case "constant": return 0;
    case "x": return h;
    case "add": return smallRise(expression.left, a, h) + smallRise(expression.right, a, h);
    case "subtract": return smallRise(expression.left, a, h) - smallRise(expression.right, a, h);
    case "multiply": {
      const left = evaluate(expression.left, b)[0];
      const right = evaluate(expression.right, a)[0];
      return smallRise(expression.left, a, h) * right + left * smallRise(expression.right, a, h);
    }
    case "power": {
      const [left] = evaluate(expression.base, a);
      const [right] = evaluate(expression.base, b);
      let factor = 0;
      for (let i = 0; i < expression.exponent; i++)
        factor += left ** i * right ** (expression.exponent - 1 - i);
      return smallRise(expression.base, a, h) * factor;
    }
    case "smooth": {
      const k = expression.steepness;
      const z = k * (evaluate(expression.input, a)[0] - 0.5);
      const dz = k * smallRise(expression.input, a, h);
      const difference = Math.abs(dz) < 0.5
        ? sigmoid(z) * sigmoid(-z - dz) * Math.expm1(dz)
        : sigmoid(z + dz) - sigmoid(z);
      return difference / (1 - 2 * sigmoid(-k / 2));
    }
    case "piecewise": {
      const { at, before, after } = expression;
      const [first, second] = a < at ? [before, after] : [after, before];
      const toJoin = at - a;
      if (a < at ? h <= toJoin : h >= toJoin) return smallRise(first, a, h);
      // Preserve the signed run when a + h has rounded near the join.
      return smallRise(first, a, toJoin) + smallRise(second, at, h - toJoin);
    }
  }
}

function compatible(display: Display, h: number) {
  if (display === "tangent" || display === "compare") return h === 0;
  if (display === "difference" || display === "secant" || display === "limit") return h !== 0;
  return true;
}

export function endFrame(plan: SemanticPlan, beat: number): number {
  return plan.beats[beat + 1]?.startFrame ?? plan.durationSeconds * semanticFps;
}

export function narrationWindow(plan: SemanticPlan, index: number) {
  return { cueFrame: plan.beats[index].cueFrame, speechEndFrame: endFrame(plan, index) - 9 };
}

type Point = { x: number; y: number };
function lineAt({ domain: [lo, hi], expression }: SemanticPlan["graph"], a: number, h: number) {
  const b = a + h;
  if (!(lo <= a && a <= hi && lo <= b && b <= hi))
    throw new Error("Points must be within the graph domain");
  const [p, derivative] = evaluate(expression, a);
  const [q, dq] = h === 0 ? [p, derivative] : evaluate(expression, b);
  const difference = q - p;
  const rise = h !== 0 && Math.abs(difference) < 1e-8 * Math.max(1, Math.abs(p), Math.abs(q))
    ? smallRise(expression, a, h)
    : difference;
  const slope = h === 0 ? derivative : rise / h;
  if ((h !== 0 && b === a) || ![p, q, derivative, dq, slope].every(magnitude))
    throw new Error("Graph geometry exceeds the supported range");
  return {
    p: { x: a, y: p },
    q: { x: b, y: q },
    h,
    rise,
    slope,
    kind: h === 0 ? "tangent" as const : "secant" as const,
  };
}

export function validSemanticPlan(value: unknown): value is SemanticPlan {
  const graph = (value as { graph?: { expression?: unknown } } | null)?.graph;
  if (!boundedExpression(graph?.expression) || !Schema.Check(jsonSchema, value)) return false;
  const plan = value as SemanticPlan;
  const { domain: [lo, hi], expression, xLabel, yLabel, slopeUnit } = plan.graph;
  if (!(lo < hi) || ![plan.title, xLabel, yLabel, slopeUnit ?? "unit"].every(plain)) return false;
  const contains = (c: Camera, p: Point) =>
    Math.abs(p.x - c.x) <= c.width / 2 + 1e-10 &&
    Math.abs(p.y - c.y) <= c.height / 2 + 1e-10;
  try {
    if (expression.op === "piecewise" &&
      (!(lo < expression.at && expression.at < hi) || !evaluate(expression, expression.at).every(magnitude))) return false;
    for (const [i, beat] of plan.beats.entries()) {
      const { startFrame, settleFrame, cueFrame, a, h, display, camera, reference, narration, caption } = beat;
      const previous = plan.beats[i - 1];
      const process = beat.narrationScope === "process";
      const moves = previous && ((previous.display !== "function" && (a !== previous.a || h !== previous.h)) ||
        camera.x !== previous.camera.x || camera.y !== previous.camera.y ||
        camera.width !== previous.camera.width || camera.height !== previous.camera.height);
      if (
        (i === 0 ? startFrame !== 0 || settleFrame !== 0 : startFrame <= previous.startFrame) ||
        settleFrame < startFrame || settleFrame > startFrame + (process ? 300 : 150) ||
        (process ? !moves || cueFrame <= startFrame || cueFrame > settleFrame - 12 ||
          settleFrame >= endFrame(plan, i)
          : cueFrame < settleFrame + 12) ||
        cueFrame >= narrationWindow(plan, i).speechEndFrame ||
        !plain(narration) || (caption !== undefined && !plain(caption)) ||
        (h !== 0 && Math.abs(h) < 0.0001) || (previous && h * previous.h < 0) ||
        !compatible(display, h) || (display === "compare") !== (reference !== undefined)
      ) return false;
      const { p, q } = lineAt(plan.graph, a, h);
      if (!contains(camera, p) || !contains(camera, q)) return false;
      if (reference !== undefined && (reference === a ||
        !contains(camera, lineAt(plan.graph, reference, 0).p))) return false;
      for (let frame = startFrame; frame < settleFrame; frame++) semanticFrame(plan, frame);
    }
    for (let i = 0; i <= 256; i++) {
      if (!evaluate(expression, lo + (hi - lo) * i / 256).every(magnitude)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const lerp = (a: number, b: number, t: number) => a === b ? a : a * (1 - t) + b * t;
const scale = (a: number, b: number, t: number) => Math.exp(lerp(Math.log(a), Math.log(b), t));

/** Frame-local semantics, shared by the graph and the audio/visual scheduler. */
export function semanticFrame(plan: SemanticPlan, frame: number) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= plan.durationSeconds * semanticFps)
    throw new Error("Frame outside the lesson");
  let index = plan.beats.length - 1;
  while (frame < plan.beats[index].startFrame) index--;
  const beat = plan.beats[index];
  const previous = plan.beats[index - 1];
  let { a, h, camera, display, reference } = beat;
  if (previous && frame < beat.settleFrame) {
    const u = (frame - beat.startFrame) / (beat.settleFrame - beat.startFrame);
    const t = u * u * (3 - 2 * u);
    a = lerp(previous.a, a, t);
    h = lerp(previous.h, h, t);
    camera = {
      x: lerp(previous.camera.x, camera.x, t),
      y: lerp(previous.camera.y, camera.y, t),
      width: scale(previous.camera.width, camera.width, t),
      height: scale(previous.camera.height, camera.height, t),
    };
    display = compatible(previous.display, h) ? previous.display : "points";
    reference = display === "compare" ? previous.reference : undefined;
  }
  if (display === "compare" && reference === a) {
    display = "points";
    reference = undefined;
  }
  const line = lineAt(plan.graph, a, h);
  const other = reference === undefined ? undefined : lineAt(plan.graph, reference, 0);
  return {
    frame, index, display, camera, cueFrame: beat.cueFrame,
    narrationScope: beat.narrationScope ?? "settled",
    ...line,
    reference: other && { ...other.p, slope: other.slope },
  };
}

export function sampleCurve(plan: SemanticPlan, camera: Camera): Point[] {
  const lo = Math.max(plan.graph.domain[0], camera.x - camera.width / 2);
  const hi = Math.min(plan.graph.domain[1], camera.x + camera.width / 2);
  if (lo > hi) return [];
  return Array.from({ length: 113 }, (_, i) => {
    const x = lerp(lo, hi, i / 112);
    const y = evaluate(plan.graph.expression, x)[0];
    if (!magnitude(y)) throw new Error("Graph geometry exceeds the supported range");
    return { x, y };
  });
}
