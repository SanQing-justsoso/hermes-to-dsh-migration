// Reconcile DSH sessions: remove prior imports (identified by a strict signature
// that only Hermes-migrated sessions have), prune their ids from workspace.json,
// then install the current valid staging sessions and register them.
// Safe by construction: DSH's own sessions have non-empty assistant `stream` and
// system/message + request/header events, so they never match the signature.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = 0xFD2FB528;
function frameEnd(b, s) {
  let o = s + 4; const f = b[o]; o += 1;
  const fc = (f >> 6) & 3, sg = (f >> 5) & 1, ck = (f >> 2) & 1, di = f & 3;
  o += { 0: 0, 1: 1, 2: 2, 3: 4 }[di];
  if (!sg) o += 1;
  o += (fc === 0 ? (sg ? 1 : 0) : { 1: 2, 2: 4, 3: 8 }[fc]);
  for (;;) {
    const h = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); o += 3;
    const bt = (h >> 1) & 3, bs = h >> 3; o += bt === 1 ? 1 : bs;
    if (h & 1) break;
  }
  if (ck) o += 4;
  return o;
}
function decodeEvents(file) {
  const b = fs.readFileSync(file); let o = 0; const offs = [];
  while (o < b.length) { const e = frameEnd(b, o); offs.push([o, e]); o = e; }
  const parts = offs.map(([s, e]) => zlib.zstdDecompressSync(b.subarray(s, e)));
  const lines = Buffer.concat(parts).toString("utf8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}
// A session is one of ours iff: v4; first four events are our exact preamble;
// no DSH-only events (DSH always emits request/header and, for the top-level
// agent, system/message); and it carries an assistant message.
function isOurImport(evs) {
  if (!evs[0] || evs[0].type !== "session" || evs[0].version !== 4) return false;
  const want = ["permission/preset", "sandbox/mode", "approval/policy", "model/selection"];
  for (let i = 0; i < 4; i++) if (!evs[1 + i] || evs[1 + i].type !== want[i]) return false;
  let sawAssistant = false;
  for (let i = 1; i < evs.length; i++) {
    const t = evs[i].type;
    if (t === "system/message" || t === "request/header" || t === "request/context" || t === "agent/inbox/spliced") return false;
    if (t === "assistant/message") sawAssistant = true;
  }
  return sawAssistant;
}

const [,, sessionsDir, stagingDir, wsJson, mode /* dry-run|apply */] = process.argv;
const staging = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).filter((d) => /^session-.*\/$/.test("") || fs.existsSync(path.join(stagingDir, d, "session.v4.jsonl.zstd"))) : [];

// 1) find & remove our prior imports
const removed = [];
for (const d of fs.readdirSync(sessionsDir)) {
  const p = path.join(sessionsDir, d, "session.v4.jsonl.zstd");
  if (!fs.existsSync(p)) continue;
  if (staging.includes(d)) continue; // will be overwritten anyway; don't double-handle
  let evs; try { evs = decodeEvents(p); } catch { continue; }
  if (isOurImport(evs)) {
    removed.push(d);
    if (mode === "apply") fs.rmSync(path.join(sessionsDir, d), { recursive: true, force: true });
  }
}

// 2) copy staging sessions (overwrite)
let copied = 0;
for (const d of staging) {
  const dst = path.join(sessionsDir, d);
  if (mode === "apply") {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(path.join(stagingDir, d), dst, { recursive: true });
  }
  copied++;
}

// 3) reconcile workspace.json: keep only ids whose dir exists, then add staging ids
let added = 0;
if (fs.existsSync(wsJson)) {
  const ws = JSON.parse(fs.readFileSync(wsJson, "utf8"));
  const exists = (id) => fs.existsSync(path.join(sessionsDir, id));
  for (const w of Object.values(ws.tables?.workspaces || {})) {
    const before = Array.isArray(w.sessionIds) ? w.sessionIds : [];
    const kept = mode === "apply" ? before.filter(exists) : before; // dry-run: don't prune to avoid misleading counts
    const set = new Set(kept);
    for (const d of staging) if (!set.has(d)) { set.add(d); added++; }
    w.sessionIds = [...set];
  }
  // global archived/pinned prune handled by DSH; leave as-is
  if (mode === "apply") fs.writeFileSync(wsJson, JSON.stringify(ws, null, 2));
}

console.log(JSON.stringify({ mode, removedPriorImports: removed.length, removedSample: removed.slice(0, 6), installSessions: copied, registeredNew: added }, null, 2));
