#!/usr/bin/env python3
"""install_head_repairs.py — install staged repaired session logs into a live
DSH sessions tree (the second half of batch_repair_heads.mjs).

Safety rules, in order, per session:
  1. the live session log must exist
  2. if the session directory holds a session.lock, it is probed with a
     non-blocking exclusive flock — a lock actually HELD by a running DSH
     process skips the session (the mere existence of the file means nothing:
     DSH leaves lock files behind on scanned sessions)
  3. the current live file is backed up (copy) before any write
  4. the staged file is copied next to the target and then atomically renamed
     over it, so a concurrent reader never sees a torn file

Usage:
  python3 install_head_repairs.py --staging <dir> --sessions-root <dir> \
      [--backup <dir>]

Exit code is non-zero iff any session failed to install; skipped-locked
sessions are reported so a later pass (with DSH idle) can finish them.
"""
import argparse
import fcntl
import os
import shutil


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--staging", required=True)
    ap.add_argument("--sessions-root", required=True)
    ap.add_argument("--backup", required=True)
    args = ap.parse_args()

    os.makedirs(args.backup, exist_ok=True)
    installed, skipped_locked, failed = [], [], []

    for sid in sorted(os.listdir(args.staging)):
        staged = os.path.join(args.staging, sid, "session.v4.jsonl.zstd")
        if not os.path.exists(staged):
            continue
        live = os.path.join(args.sessions_root, sid, "session.v4.jsonl.zstd")
        if not os.path.exists(live):
            failed.append(sid + " (live log missing)")
            continue
        lock = os.path.join(args.sessions_root, sid, "session.lock")
        if os.path.exists(lock):
            with open(lock, "a+") as f:
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    skipped_locked.append(sid)
                    continue
                fcntl.flock(f, fcntl.LOCK_UN)
        try:
            shutil.copy2(live, os.path.join(args.backup, sid + ".zstd"))
            tmp = live + ".repaired.tmp"
            shutil.copy2(staged, tmp)
            os.replace(tmp, live)
            installed.append(sid)
        except OSError as e:
            failed.append(sid + " (" + str(e) + ")")
            tmp = live + ".repaired.tmp"
            if os.path.exists(tmp):
                os.unlink(tmp)

    print("installed:", len(installed))
    print("skipped_locked:", len(skipped_locked), skipped_locked)
    print("failed:", failed)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
