#!/usr/bin/env node
// Hermes -> DSH session.v4 encoder.
// Reads the normalized intermediate produced by extract_hermes_sessions.py and
// emits, for each Hermes session, a DSH-native append-only event log compressed
// as one checksummed zstd frame per line (exactly how DSH persists sessions).
//
// Event schema was reverse-engineered from a real DSH session.v4.jsonl.zstd.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

// Configure via env: NORM_DIR, OUT_DIR, SESSION_CWD, PROVIDER, MODEL, TZ
const NORM = process.env.NORM_DIR || path.join(process.cwd(), "normalized");
const META = JSON.parse(fs.readFileSync(path.join(NORM, "_meta.json"), "utf8"));
const OUTROOT = process.env.OUT_DIR || process.argv[2] || path.join(process.cwd(), "sessions");
const CWD = process.env.SESSION_CWD || process.cwd();
const PROVIDER = process.env.PROVIDER || "stepfun";
const MODEL = process.env.MODEL || "step-5-preview";
const TZ = process.env.TZ || "Asia/Shanghai";

const uuid = () => crypto.randomUUID();
const CHECK = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

// Reuse previously-assigned DSH session ids (keyed by Hermes id) so re-encoding
// fixes invalidate in place (same dir names) instead of creating duplicates.
let IDMAP = {};
try {
  const prev = JSON.parse(fs.readFileSync(path.join(path.dirname(OUTROOT), "_session_map.json"), "utf8"));
  for (const m of prev) IDMAP[m.hermes_session_id] = m.dsh_session_id;
} catch {}

// Encapsulate an event and return its serialized line WITH trailing newline.
function line(obj) { return Buffer.from(JSON.stringify(obj) + "\n", "utf8"); }

function buildSession(meta, rows) {
  const header = {
    type: "session", version: 4, id: IDMAP[meta.hermes_session_id] || `session-${uuid()}`,
    createdAt: Math.round((meta.started_at || Date.now() / 1000) * 1000),
    cwd: CWD, isSeeded: false, delegationDepth: 0, agentPreset: "standard",
  };
  const events = [];
  let seq = 0;
  const at = (ts) => Math.round((ts || meta.started_at || 0) * 1000) || header.createdAt + seq;
  const push = (type, data, extra = {}) => {
    const ev = { type, seq: seq++, time: at(LAST_TS), data, ...extra };
    events.push(ev);
    return ev;
  };
  let LAST_TS = meta.started_at || 0;

  // config preamble (matches a real DSH session's opening events)
  push("permission/preset", { preset: "workspace-write" });
  push("sandbox/mode", { mode: "workspace-write" });
  push("approval/policy", { policy: "ask" });
  push("model/selection", { provider: PROVIDER, model: MODEL });

  let turn = 0, step = 0, stepOpen = false, turnOpen = false;
  let firstUserSeq = null, titleEmitted = false;
  const usedCallIds = new Set();          // per-turn uniqueness of advertised tool-call ids
  let advertised = [];                    // [{cid,name,args}] advertised calls awaiting tool/result in current step

  const openStep = () => { step += 1; push("step/start", { turn, step }); stepOpen = true; };
  const closeStep = () => { if (stepOpen) { push("step/end", { turn, step }); stepOpen = false; } };
  const synthResults = () => {            // turn/end requires zero unresolved tools; synthesize any dangling
    if (!stepOpen) return;
    for (const a of advertised) {
      push("tool/result", {
        turn, step,
        message: { role: "tool", source: { kind: "tool", callId: a.cid }, toolCallId: a.cid,
          content: [{ type: "text", text: "(此工具调用在 Hermes 历史中未记录到结果)" }], isError: false, id: uuid() },
      }, { surfaceOp: "append" });
    }
    advertised = [];
  };
  const flushStep = () => { synthResults(); closeStep(); };
  const closeTurn = () => { flushStep(); if (turnOpen) { push("turn/end", { turn, reason: { kind: "completed" } }); turnOpen = false; } };
  const startTurn = () => { closeTurn(); turn += 1; step = 0; usedCallIds.clear(); push("turn/start", { turn }); turnOpen = true; };

  const ensureTitle = (userTextSeq, ts) => {
    if (titleEmitted) return;
    titleEmitted = true;
    const title = (meta.title && meta.title.trim()) ? meta.title.slice(0, 80)
      : (rows.find(r => r.role === "user")?.text || "Imported Hermes session").trim().slice(0, 80);
    push("session/title", { title, messageSeqs: [userTextSeq], source: { kind: "fallback" } });
  };

  for (const r of rows) {
    LAST_TS = r.ts || LAST_TS;
    if (r.role === "user") {
      startTurn();
      openStep();
      const id = uuid();
      const ev = push("user/message", {
        content: [{ type: "text", text: r.text || "" }],
        source: { kind: "user", rpcId: uuid(), clientTimeZone: TZ },
        role: "user", id,
      }, { surfaceOp: "append" });
      if (firstUserSeq === null) { firstUserSeq = ev.seq; ensureTitle(firstUserSeq); }
    } else if (r.role === "assistant") {
      if (!turnOpen) startTurn();
      if (stepOpen) flushStep();
      openStep();
      const content = [];
      const blocks = [];
      if (r.reasoning) { content.push({ type: "reasoning", text: r.reasoning }); blocks.push({ type: "reasoning", thinkingSignature: "reasoning_content" }); }
      if (r.text) { content.push({ type: "text", text: r.text }); blocks.push({ type: "text" }); }
      const calls = r.tool_calls || [];
      const norm = [];
      for (const c of calls) {
        let cid = (c.id && String(c.id)) || `call-${uuid()}`;
        if (usedCallIds.has(cid)) cid = `${cid}#${norm.length + 2}`;   // keep advertised ids unique within the turn
        usedCallIds.add(cid);
        const name = String(c.name || ""), args = String(c.arguments || "");
        content.push({ type: "tool-call", id: cid, name, arguments: args }); blocks.push({ type: "tool-call" });
        norm.push({ cid, name, args });
      }
      const stopReason = calls.length ? "toolUse" : "endTurn";
      push("assistant/message", {
        turn, step,
        message: {
          role: "assistant", content,
          source: { kind: "model", provider: PROVIDER, model: MODEL,
            replayState: { response: { kind: "pi-ai", version: 2, api: "openai-completions", provider: PROVIDER, model: MODEL, responseId: uuid(), stopReason }, blocks } },
          id: uuid(),
        },
        stream: [],
      }, { surfaceOp: "append" });
      for (const a of norm) {
        advertised.push(a);
        push("tool/call", { turn, step, callId: a.cid, name: a.name, arguments: a.args });
      }
    } else if (r.role === "tool") {
      if (!turnOpen) startTurn();
      if (!stepOpen) openStep();
      let idx = -1; const callId = r.tool_call_id;
      if (callId) idx = advertised.findIndex(a => a.cid === callId);
      if (idx < 0 && advertised.length) idx = 0;
      if (idx < 0) continue;               // orphan tool result (its assistant was dropped) — skip to stay valid
      const a = advertised.splice(idx, 1)[0];
      push("tool/result", {
        turn, step,
        message: { role: "tool", source: { kind: "tool", callId: a.cid }, toolCallId: a.cid,
          content: [{ type: "text", text: r.text || "" }], isError: false, id: uuid() },
      }, { surfaceOp: "append" });
    }
  }
  closeTurn();

  // serialize: header is its own frame (one line); each event its own frame
  const frames = [line(header), ...events.map(e => line(e))];
  const compressed = Buffer.concat(frames.map(f => zlib.zstdCompressSync(f, CHECK)));
  return { header, events, compressed, seqCount: seq };
}

fs.mkdirSync(OUTROOT, { recursive: true });
const summary = [];
for (const meta of META) {
  const p = path.join(NORM, `${meta.hermes_session_id}.jsonl`);
  if (!fs.existsSync(p)) continue;
  const rows = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const { header, events, compressed, seqCount } = buildSession(meta, rows);
  const dir = path.join(OUTROOT, header.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), compressed);
  fs.writeFileSync(path.join(dir, "session.lock"), "");
  summary.push({ hermes_session_id: meta.hermes_session_id, dsh_session_id: header.id, title: meta.title, events: events.length, seq: seqCount, created: new Date(header.createdAt).toISOString() });
  console.log(`OK ${header.id}  events=${events.length}  title=${meta.title || "(untitled)"}`);
}
const _mapPath = path.join(path.dirname(OUTROOT), "_session_map.json");
let _existing = [];
try { _existing = JSON.parse(fs.readFileSync(_mapPath, "utf8")); } catch {}
fs.writeFileSync(_mapPath, JSON.stringify(_existing.concat(summary), null, 2));
console.log(`\nBatch sessions: ${summary.length}  (total mapped: ${_existing.length + summary.length})`);
