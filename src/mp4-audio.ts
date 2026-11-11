/** Read only bounded ISO-BMFF metadata from the renderer's own output. */
type Box = { type: string; start: number; end: number };
function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const result: Box[] = [];
  while (start < end) {
    if (end - start < 8) throw new Error("Truncated MP4 box");
    let size = bytes.readUInt32BE(start);
    const type = bytes.toString("ascii", start + 4, start + 8);
    let header = 8;
    if (size === 1) {
      if (end - start < 16) throw new Error("Truncated extended MP4 box");
      const large = bytes.readBigUInt64BE(start + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("MP4 box too large");
      size = Number(large);
      header = 16;
    } else if (size === 0) size = end - start;
    if (size < header || size > end - start)
      throw new Error("Invalid MP4 box size");
    result.push({ type, start: start + header, end: start + size });
    start += size;
  }
  return result;
}
function child(bytes: Buffer, parent: Box, type: string): Box | undefined {
  return boxes(bytes, parent.start, parent.end).find(
    (box) => box.type === type,
  );
}
function read32(bytes: Buffer, box: Box, offset: number): number {
  if (box.start + offset + 4 > box.end)
    throw new Error("Truncated MP4 metadata");
  return bytes.readUInt32BE(box.start + offset);
}
export function hasPlayableAudioTrack(bytes: Buffer): boolean {
  if (bytes.length < 8 || bytes.length > 25_000_000)
    throw new Error("Invalid MP4 size");
  const top = boxes(bytes, 0, bytes.length);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) throw new Error("Missing MP4 metadata");
  for (const track of boxes(bytes, moov.start, moov.end).filter(
    (box) => box.type === "trak",
  )) {
    const mdia = child(bytes, track, "mdia");
    if (!mdia) continue;
    const handler = child(bytes, mdia, "hdlr");
    if (
      !handler ||
      handler.start + 12 > handler.end ||
      bytes.toString("ascii", handler.start + 8, handler.start + 12) !== "soun"
    )
      continue;
    const mdhd = child(bytes, mdia, "mdhd");
    const minf = child(bytes, mdia, "minf");
    const stbl = minf && child(bytes, minf, "stbl");
    if (!mdhd || !stbl) continue;
    const version = bytes[mdhd.start];
    let timescale: number, duration: number;
    if (version === 0) {
      timescale = read32(bytes, mdhd, 12);
      duration = read32(bytes, mdhd, 16);
    } else if (version === 1) {
      timescale = read32(bytes, mdhd, 20);
      if (mdhd.start + 32 > mdhd.end) throw new Error("Truncated MP4 duration");
      const n = bytes.readBigUInt64BE(mdhd.start + 24);
      if (n > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("MP4 duration too large");
      duration = Number(n);
    } else throw new Error("Unsupported MP4 duration version");
    const stsd = child(bytes, stbl, "stsd"),
      stsz = child(bytes, stbl, "stsz"),
      stts = child(bytes, stbl, "stts");
    if (!stsd || !stsz || !stts || !timescale || !duration) continue;
    const samples = read32(bytes, stsz, 8),
      sampleSize = read32(bytes, stsz, 4),
      timingEntries = read32(bytes, stts, 4);
    if (
      !samples ||
      samples > 10_000_000 ||
      !timingEntries ||
      timingEntries > samples
    )
      continue;
    if (
      (!sampleSize && stsz.start + 12 + samples * 4 > stsz.end) ||
      stts.start + 8 + timingEntries * 8 > stts.end
    )
      throw new Error("Truncated MP4 sample table");
    let timedSamples = 0,
      timedDuration = 0;
    for (let i = 0; i < timingEntries; i++) {
      const count = read32(bytes, stts, 8 + i * 8),
        delta = read32(bytes, stts, 12 + i * 8);
      if (!count || !delta) throw new Error("Invalid MP4 sample timing");
      timedSamples += count;
      timedDuration += count * delta;
    }
    if (
      timedSamples !== samples ||
      !Number.isSafeInteger(timedDuration) ||
      timedDuration <= 0
    )
      throw new Error("Invalid MP4 sample timing");
    const count = read32(bytes, stsd, 4);
    const entries = boxes(bytes, stsd.start + 8, stsd.end);
    if (entries.length !== count)
      throw new Error("Invalid MP4 sample descriptions");
    if (entries.some((entry) => entry.type === "Opus" || entry.type === "mp4a"))
      return true;
  }
  return false;
}
