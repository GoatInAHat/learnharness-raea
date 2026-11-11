import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPlayableAudioTrack } from "../src/mp4-audio.ts";
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (name: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([
    u32(body.length + 8),
    Buffer.from(name, "ascii"),
    body,
  ]);
};
function sample(codec = "Opus", samples = 3) {
  const mdhd = box("mdhd", Buffer.alloc(12), u32(48000), u32(1440));
  const hdlr = box("hdlr", Buffer.alloc(8), Buffer.from("soun"));
  const stsd = box(
    "stsd",
    Buffer.alloc(4),
    u32(1),
    box(codec, Buffer.alloc(28)),
  );
  const stsz = box("stsz", Buffer.alloc(4), u32(1), u32(samples));
  const stts = box("stts", Buffer.alloc(4), u32(1), u32(samples), u32(480));
  return box(
    "moov",
    box(
      "trak",
      box("mdia", mdhd, hdlr, box("minf", box("stbl", stsd, stsz, stts))),
    ),
  );
}
test("requires a real supported sound track with samples and timing", () => {
  assert.equal(hasPlayableAudioTrack(sample("Opus")), true);
  assert.equal(hasPlayableAudioTrack(sample("mp4a")), true);
  assert.equal(hasPlayableAudioTrack(sample("junk")), false);
  assert.equal(hasPlayableAudioTrack(sample("Opus", 0)), false);
  assert.equal(hasPlayableAudioTrack(box("moov")), false);
  assert.throws(
    () => hasPlayableAudioTrack(sample().subarray(0, -1)),
    /Invalid|Truncated/,
  );
  assert.throws(
    () => hasPlayableAudioTrack(Buffer.from("not mp4!")),
    /Invalid|Missing/,
  );
});
