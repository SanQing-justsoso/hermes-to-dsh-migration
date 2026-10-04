#!/usr/bin/env node
// decode_zstd_lines.js — decode a DSH session.v4.jsonl.zstd into plain JSONL.
//
// DSH stores one JSONL line per independent checksummed zstd frame, frames
// concatenated (RFC 8878). Node's zlib only decodes the FIRST frame (both
// zstdDecompressSync and the stream API stop after frame 1), so we walk the
// frame headers ourselves and decompress frame by frame.
//
// Usage: node decode_zstd_lines.js <in.zstd> <out.jsonl>
import fs from "node:fs";
import zlib from "node:zlib";

const p = process.argv[2];
const b = fs.readFileSync(p);
const n = b.length;
let o = 0;
let idx = 0;
const problems = [];
const out = [];

while (o < n) {
  const start = o;
  if (o + 4 > n) { problems.push(`truncated magic at ${o}`); break; }
  const magic = b.readUInt32LE(o);
  if (magic !== 0xfd2fb528) { problems.push(`bad magic at ${o}: 0x${magic.toString(16)}`); break; }
  o += 4;
  const fhd = b[o]; o += 1;
  const fcsFlag = (fhd >> 6) & 3, singleSeg = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  const didSize = { 0: 0, 1: 1, 2: 2, 3: 4 }[dictFlag]; o += didSize;
  if (!singleSeg) o += 1;
  const fcsSize = fcsFlag === 0 ? (singleSeg ? 1 : 0) : { 1: 2, 2: 4, 3: 8 }[fcsFlag]; o += fcsSize;
  for (;;) {
    if (o + 3 > n) { problems.push(`truncated block header at ${o}`); o = n; break; }
    const bh = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    o += 3;
    const last = bh & 1, btype = (bh >> 1) & 3, bsize = bh >> 3;
    if (btype === 1) o += 1; else o += bsize;
    if (last) break;
  }
  if (checksum) o += 4;
  const frame = b.subarray(start, o);
  let line;
  try {
    line = zlib.zstdDecompressSync(frame).toString("utf8");
  } catch (e) {
    line = `<<FRAME_DECODE_ERROR at byte ${start}: ${e.message}>>`;
  }
  out.push(line);
  idx++;
}

fs.writeFileSync(process.argv[3], out.join("\n") + "\n");
console.log(JSON.stringify({ file: p, bytes: n, frames: idx, problems }));
