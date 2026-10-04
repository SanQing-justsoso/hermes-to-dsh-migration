#!/usr/bin/env node
// repair_head.mjs — repair one DSH v4 session log that is missing its
// protected surface head, making it loadable again and resume-safe.
//
// Background (see README §3.7): DSH's foldSurface validator requires the
// first surface event of a log to be a system/message ("protected head").
// Imported logs whose surface starts with user/message have no protectedHead;
// when DSH later natively resumes such a session it appends a fresh
// system/message, which the validator rejects:
//   SessionFormatError: system/message requires a protected first surface head
//
// Fix (canonical shape, copied from the official dsh-chat-import plugin's
// convert/events.mjs): insert an empty-content system/message with
// surfaceOp:"append" and source {kind:"system-prompt"} directly after the
// first step/start, before any surface event. Then renumber seq densely and
// remap every sourceEventSeqs / messageSeqs reference.
//
// The repaired log is repacked as one checksummed zstd frame per JSONL line,
// byte-style-compatible with DSH's own writer
// (zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }))
// — note Node's plain {checksum:true} option is silently ignored on Node 22.
//
// Idempotent: if the first surface event already is system/message, the file
// is copied through unchanged.
//
// Usage:
//   node repair_head.mjs <in.zstd> <out.zstd> [--id <sessionId>]
//
// Full loader-rule validation (dense seq, surfaceOp presence, foldSurface
// protected-head rule, system/message step matching, tool lifecycle per step,
// turn/step nesting, per-frame round-trip) runs before anything is written;
// on failure nothing is written and the exit code is non-zero.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const inFile = args[0];
const outFile = args[1];
const idFlag = args.indexOf("--id");
const sessionId = idFlag >= 0 ? args[idFlag + 1] : path.basename(path.dirname(path.resolve(inFile)));
if (!inFile || !outFile) {
  console.error("usage: node repair_head.mjs <in.zstd> <out.zstd> [--id <sessionId>]");
  process.exit(2);
}

const SURFACE = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

function frameEnd(b, s) {
  let o = s + 4; const f = b[o]; o += 1;
  const fc = (f >> 6) & 3, sg = (f >> 5) & 1, ck = (f >> 2) & 1, di = f & 3;
  o += { 0: 0, 1: 1, 2: 2, 3: 4 }[di];
  if (!sg) o += 1;
  o += (fc === 0 ? (sg ? 1 : 0) : { 1: 2, 2: 4, 3: 8 }[fc]);
  for (;;) {
    const h = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); o += 3;
    const bt = (h >> 1) & 3, bs = h >> 3;
    o += bt === 1 ? 1 : bs;
    if (h & 1) break;
  }
  if (ck) o += 4;
  return o;
}

function decodeEvents(file) {
  const b = fs.readFileSync(file);
  let o = 0; const offs = [];
  while (o < b.length) { const e = frameEnd(b, o); offs.push([o, e]); o = e; }
  return Buffer.concat(offs.map(([s, e]) => zlib.zstdDecompressSync(b.subarray(s, e)))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Insert the protected head; returns null when the log needs no repair.
function transform(records) {
  const head = records[0];
  if (head.type !== "session" || head.version !== 4) throw new Error("unexpected session head");
  const events = records.slice(1);
  for (let i = 0; i < events.length; i++) if (events[i].seq !== i) throw new Error(`seq not dense at ${i}`);
  const firstSurface = events.find((e) => SURFACE.has(e.type));
  if (!firstSurface || firstSurface.type === "system/message") return null;
  const firstStepIdx = events.findIndex((e) => e.type === "step/start");
  if (firstStepIdx < 0) throw new Error("no step/start anchor for the head");
  const insertAt = firstStepIdx + 1;
  const fs0 = events[firstStepIdx];
  const headEvent = {
    type: "system/message",
    seq: insertAt,
    time: fs0.time,
    data: {
      turn: fs0.data.turn,
      step: fs0.data.step,
      message: { role: "system", content: [], source: { kind: "system-prompt" }, id: "import:" + sessionId + ":sys" },
    },
    surfaceOp: "append",
  };
  const newEvents = [...events.slice(0, insertAt), headEvent, ...events.slice(insertAt)];
  const oldToNew = new Map();
  events.forEach((e, i) => oldToNew.set(e.seq, i < insertAt ? i : i + 1));
  const remap = (arr) => (Array.isArray(arr) ? arr.map((s) => (oldToNew.has(s) ? oldToNew.get(s) : s)) : arr);
  return newEvents.map((ev, i) => {
    const next = { ...ev, seq: i };
    if (Array.isArray(ev.sourceEventSeqs)) next.sourceEventSeqs = remap(ev.sourceEventSeqs);
    if (Array.isArray(ev.data?.messageSeqs)) next.data = { ...ev.data, messageSeqs: remap(ev.data.messageSeqs) };
    return next;
  });
}

// Replica of the loader rules that matter for this shape (extracted from the
// DSH bundle's Relationships/foldSurface implementation).
function validate(head, finalEvents) {
  const problems = [];
  let surface = [];
  let protectedHead;
  let openStep = null;
  let openTurn = null;
  const stepSeq = (turn, step) => finalEvents.findIndex((e) => e.type === "step/start" && e.data.turn === turn && e.data.step === step);
  const callsByStep = new Map();
  for (const e of finalEvents) {
    if (SURFACE.has(e.type) && e.surfaceOp === undefined) problems.push(`${e.type} seq ${e.seq}: missing surfaceOp`);
    if (e.type === "turn/start") { if (openTurn !== null) problems.push(`nested turn/start at ${e.seq}`); openTurn = e.data.turn; }
    if (e.type === "turn/end") { if (openTurn !== e.data.turn) problems.push(`turn/end mismatch at ${e.seq}`); openTurn = null; openStep = null; }
    if (e.type === "step/start") {
      if (openStep !== null) problems.push(`nested step/start at ${e.seq}`);
      openStep = { turn: e.data.turn, step: e.data.step };
      callsByStep.set(e.seq, new Set());
    }
    if (e.type === "step/end") {
      if (!openStep || openStep.turn !== e.data.turn || openStep.step !== e.data.step) problems.push(`step/end mismatch at ${e.seq}`);
      openStep = null;
    }
    if (e.type === "tool/call") {
      const ss = stepSeq(openStep.turn, openStep.step);
      if (ss < 0) problems.push(`tool/call outside step at ${e.seq}`);
      else callsByStep.get(ss).add(e.data.callId);
    }
    if (e.type === "tool/result") {
      const ss = stepSeq(openStep.turn, openStep.step);
      const id = e.data.message?.toolCallId;
      if (ss < 0) problems.push(`tool/result outside step at ${e.seq}`);
      else if (id && !callsByStep.get(ss)?.has(id)) problems.push(`tool/result without matching call in step at ${e.seq}`);
    }
    if (SURFACE.has(e.type)) {
      if (e.type === "system/message") {
        if (surface.length > 0 && protectedHead === undefined) problems.push(`system/message on non-empty surface without protectedHead at ${e.seq}`);
        if (!openStep || openStep.turn !== e.data.turn || openStep.step !== e.data.step) problems.push(`system/message does not match open step at ${e.seq}`);
      }
      if (e.surfaceOp === "append") {
        if (e.type === "system/message" && surface.length === 0) protectedHead = e.seq;
        surface.push(e.seq);
      } else {
        problems.push(`unexpected non-append surfaceOp at ${e.seq}`);
      }
    }
  }
  const first = finalEvents.find((e) => SURFACE.has(e.type));
  if (!first || first.type !== "system/message") problems.push("first surface event is not the system head");
  if (protectedHead === undefined) problems.push("protectedHead never established");
  return problems;
}

const records = decodeEvents(inFile);
const head = records[0];
const finalEvents = transform(records);

if (finalEvents === null) {
  fs.copyFileSync(inFile, outFile);
  console.log(JSON.stringify({ file: inFile, changed: false, reason: "already has protected head" }));
  process.exit(0);
}

const problems = validate(head, finalEvents);
if (problems.length > 0) {
  console.error(JSON.stringify({ file: inFile, validationFailed: problems.slice(0, 5) }, null, 1));
  process.exit(1);
}

const lines = [head, ...finalEvents].map((r) => JSON.stringify(r));
const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + "\n"), CHECKSUM));
frames.forEach((f, i) => {
  if (f.readUInt32LE(0) !== 0xfd2fb528) throw new Error(`frame ${i}: bad magic`);
  if (((f[4] >> 2) & 1) !== 1) throw new Error(`frame ${i}: checksum flag missing`);
  if (zlib.zstdDecompressSync(f).toString("utf8") !== lines[i] + "\n") throw new Error(`frame ${i}: round-trip mismatch`);
});

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat(frames));
console.log(JSON.stringify({
  file: inFile,
  changed: true,
  events: finalEvents.length,
  frames: frames.length,
  protectedHeadSeq: finalEvents.find((e) => SURFACE.has(e.type)).seq,
  bytes: Buffer.concat(frames).length,
  output: outFile,
}));
