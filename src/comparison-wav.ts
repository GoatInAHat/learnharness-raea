import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { narrationWindow, semanticFps, type SemanticPlan } from "./semantic-math.ts";

export const maxWavBytes = 12_000_000;

export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes)
      throw new Error("Input file exceeds its size or file type limit");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error("Input file changed while reading");
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await fd.close();
  }
}

/** Admit a bounded, cue-aligned PCM master before it reaches the decoder. */
export function validateComparisonWav(bytes: Buffer, plan: SemanticPlan): void {
  const invalid = () => new Error("Expected a mono 16-bit PCM WAV at 16–48 kHz");
  if (bytes.length < 44 || bytes.length > maxWavBytes ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 12) !== "WAVE") throw invalid();
  let rate = 0;
  let pcm: Buffer | undefined;
  for (let i = 12; i < bytes.length;) {
    if (bytes.length - i < 8) throw invalid();
    const tag = bytes.toString("ascii", i, i + 4);
    const size = bytes.readUInt32LE(i + 4);
    const start = i + 8;
    i = start + size + (size % 2);
    if (i > bytes.length) throw invalid();
    if (tag === "fmt ") {
      if (rate || size < 16 || size > 40 ||
        bytes.readUInt16LE(start) !== 1 ||
        bytes.readUInt16LE(start + 2) !== 1 ||
        bytes.readUInt16LE(start + 12) !== 2 ||
        bytes.readUInt16LE(start + 14) !== 16) throw invalid();
      rate = bytes.readUInt32LE(start + 4);
      if (rate < 16_000 || rate > 48_000 || bytes.readUInt32LE(start + 8) !== 2 * rate)
        throw invalid();
    }
    if (tag === "data") {
      if (!rate || pcm || size % 2 !== 0 || size === 0) throw invalid();
      pcm = bytes.subarray(start, start + size);
    }
  }
  if (!pcm || Math.abs(pcm.length / 2 - plan.durationSeconds * rate) > rate / semanticFps)
    throw new Error("Narration WAV must span the lesson duration");
  const sampleAt = (frame: number) => Math.min(pcm.length / 2, Math.round(frame * rate / semanticFps));
  let previousEnd = 0;
  function peak(first: number, end: number) {
    let max = 0;
    for (let i = first; i < end; i++) max = Math.max(max, Math.abs(pcm!.readInt16LE(i * 2)));
    return max;
  }
  for (const i of plan.beats.keys()) {
    const { cueFrame, speechEndFrame } = narrationWindow(plan, i);
    const start = sampleAt(cueFrame);
    const end = sampleAt(speechEndFrame);
    if (peak(previousEnd, start) > 100) throw new Error("Narration WAV has audio outside its cue windows");
    if (peak(start, end) < 16) throw new Error(`Narration WAV is silent at beat ${i + 1}`);
    previousEnd = end;
  }
  if (peak(previousEnd, pcm.length / 2) > 100)
    throw new Error("Narration WAV has audio outside its cue windows");
}
