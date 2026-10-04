#!/usr/bin/env node
// batch_repair_heads.mjs — repair the protected surface head across many DSH
// v4 session logs. See scripts/repair_head.mjs for the background and the
// canonical head shape; this wrapper only adds discovery + reporting and
// writes results into a staging directory. It never touches the live
// $DSH_HOME tree — pairing it with install_head_repairs.py is deliberate:
// build + validate everything first, install second.
//
// Usage:
//   node batch_repair_heads.mjs --sessions-root <dir> --staging <dir> \
//       [--map <session-id-map.json>] [--include <id1,id2,...>]
//
//   --sessions-root   the DSH sessions directory to scan
//                     (e.g. $DSH_HOME/sessions/<sanitized-cwd>)
//   --staging         where repaired session.v4.jsonl.zstd files are written
//                     (staging/<sessionId>/session.v4.jsonl.zstd)
//   --map             optional JSON file, either [{dsh_session_id}] or
//                     {id: ...} array form, restricting the scan to those ids
//   --include         optional comma-separated id filter (same effect as --map)
//
// Session ids may also be given as plain directory names; anything that is
// not a readable session log is reported and skipped, never guessed.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionsRoot = flag("sessions-root");
const staging = flag("staging");
const mapFile = flag("map");
const include = flag("include")?.split(",").map((s) => s.trim()).filter(Boolean);
if (!sessionsRoot || !staging) {
  console.error("usage: node batch_repair_heads.mjs --sessions-root <dir> --staging <dir> [--map <file>] [--include <id,id>]");
  process.exit(2);
}

let ids = [];
if (mapFile) {
  const raw = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  const list = Array.isArray(raw) ? raw : Object.values(raw).flat();
  ids = list.map((e) => (typeof e === "string" ? e : e.dsh_session_id ?? e.id ?? e.sessionId)).filter(Boolean);
} else {
  ids = fs.readdirSync(sessionsRoot).filter((d) => fs.existsSync(path.join(sessionsRoot, d, "session.v4.jsonl.zstd")));
}
if (include) ids = ids.filter((id) => include.includes(id));

const SURFACE = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);

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

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const repairScript = path.join(path.dirname(new URL(import.meta.url).pathname), "repair_head.mjs");
const report = { repaired: 0, alreadyHasHead: 0, noSurface: 0, failed: [], skipped: [] };

for (const id of ids) {
  const live = path.join(sessionsRoot, id, "session.v4.jsonl.zstd");
  if (!fs.existsSync(live)) { report.skipped.push(id + " (missing)"); continue; }
  // classify first: logs with zero surface events need no head at all
  let evs;
  try { evs = decodeEvents(live); } catch (e) { report.failed.push({ id, err: "undecodable: " + String(e.message).slice(0, 80) }); continue; }
  const firstSurface = evs.slice(1).find((e) => SURFACE.has(e.type));
  if (!firstSurface) { report.noSurface++; continue; }
  if (firstSurface.type === "system/message") { report.alreadyHasHead++; continue; }
  const staged = path.join(staging, id, "session.v4.jsonl.zstd");
  try {
    const out = execFileSync(process.execPath, [repairScript, live, staged, "--id", id], { encoding: "utf8" });
    const res = JSON.parse(out.trim().split("\n").pop());
    if (res.changed) report.repaired++; else report.alreadyHasHead++;
  } catch (e) {
    report.failed.push({ id, err: String(e.message).slice(0, 160) });
  }
}

console.log(JSON.stringify({ ...report, scanned: ids.length, staging }, null, 1));
if (report.failed.length > 0) process.exit(1);
