#!/usr/bin/env python3
"""Split a DSH session.v4.jsonl.zstd (one checksummed zstd frame per JSONL line,
frames concatenated) into exact per-frame byte ranges by parsing the zstd frame
header + block headers per RFC 8878. Outputs JSON list of [start,end) offsets.
No external zstd library required."""
import sys, json, struct

MAGIC = 0xFD2FB528

def frame_end(b, start):
    """Return the byte offset just after the zstd frame beginning at b[start].
    Raises if b[start:] is not a complete zstd frame."""
    n = len(b)
    o = start
    if o + 4 > n: raise ValueError("truncated magic")
    magic = struct.unpack_from("<I", b, o)[0]
    if magic != MAGIC: raise ValueError(f"bad magic at {o}: {magic:#x}")
    o += 4
    if o + 1 > n: raise ValueError("truncated FHD")
    fhd = b[o]; o += 1
    fcs_flag = (fhd >> 6) & 0x3
    single_seg = (fhd >> 5) & 0x1
    checksum = (fhd >> 2) & 0x1
    dict_id_flag = fhd & 0x3
    did_size = {0:0,1:1,2:2,3:4}[dict_id_flag]
    o += did_size
    if not single_seg:
        o += 1  # window descriptor
    # Frame Content Size field size
    if fcs_flag == 0:
        fcs_size = 1 if single_seg else 0
    else:
        fcs_size = {1:2,2:4,3:8}[fcs_flag]
    o += fcs_size
    # Walk blocks
    while True:
        if o + 3 > n: raise ValueError("truncated block header")
        bh = b[o] | (b[o+1] << 8) | (b[o+2] << 16)
        last = bh & 1
        btype = (bh >> 1) & 0x3
        bsize = bh >> 3
        o += 3
        if btype == 1:      # RLE: 1 byte of content
            o += 1
        else:               # Raw(0) / Compressed(2): bsize bytes
            o += bsize
        if last:
            break
    if checksum:
        o += 4
    return o

def main():
    path = sys.argv[1]
    b = open(path, "rb").read()
    offs = []
    o = 0
    n = len(b)
    while o < n:
        end = frame_end(b, o)
        offs.append([o, end])
        o = end
    print(json.dumps({"bytes": n, "frames": len(offs), "offsets": offs}))

if __name__ == "__main__":
    main()
