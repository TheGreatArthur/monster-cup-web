"""Write the site's patch: what turns the original ROM into the modded one.

The site never serves a ROM. Each player gives their own original ROM to the play page, which
applies this patch in the browser (web/public/rom.js). The patch holds only the bytes that
differ, XORed with the original's, so it is useless without the original ROM.

    python tools/make_web_patch.py "2596 - Digimon World Championship (USA).nds" build/digimon_mod.nds

Format (little-endian): "DWCPATCH", u32 version (1), u32 ROM size, SHA-256 of the original,
SHA-256 of the modded ROM, u32 record count, then per record: u32 offset, u32 length, the bytes
(original XOR modded).
"""
import hashlib
import struct
import sys
from pathlib import Path

MAGIC = b"DWCPATCH"
VERSION = 1
BLOCK = 4096
MERGE_GAP = 8   # a record's header: closer runs cost less as one record


def diff_runs(a: bytes, b: bytes):
    """Yield (start, end) of the byte ranges where a and b differ."""
    start = end = None
    for block in range(0, len(a), BLOCK):
        if a[block:block + BLOCK] == b[block:block + BLOCK]:
            continue
        for i in range(block, min(block + BLOCK, len(a))):
            if a[i] == b[i]:
                continue
            if start is not None and i - end > MERGE_GAP:
                yield start, end
                start = None
            if start is None:
                start = i
            end = i + 1
    if start is not None:
        yield start, end


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    original, modded = (Path(p).read_bytes() for p in sys.argv[1:3])
    out = Path(sys.argv[3] if len(sys.argv) == 4 else "web/public/mod.patch")
    if len(original) != len(modded):
        sys.exit(f"The two ROMs differ in size ({len(original)} and {len(modded)} bytes).")
    records = [(s, bytes(x ^ y for x, y in zip(original[s:e], modded[s:e]))) for s, e in diff_runs(original, modded)]
    patch = b"".join([MAGIC, struct.pack("<II", VERSION, len(original)),
                      hashlib.sha256(original).digest(), hashlib.sha256(modded).digest(),
                      struct.pack("<I", len(records)),
                      *(struct.pack("<II", s, len(data)) + data for s, data in records)])
    out.write_bytes(patch)
    print(f"{out}: {len(records)} records, {len(patch)} bytes")


if __name__ == "__main__":
    main()
