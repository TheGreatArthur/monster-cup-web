"""Make the game's text keyboard (ui/keyboard.nxr) cheap to draw: one picture of its keys at rest.

  python tools/make_keyboard_mod.py <extracted NitroFS dir> <rom.nds> [mod dir] [preview.png]

The keyboard (the DigiEgg's name, the Online Arena's room code) is a layout of 128 parts; 57 of them
are keys, each a cell of 4 sprites that the game draws as 3D quads through NNS G2D every frame.
That halves the browser's emulator (melonDS in WebAssembly): 33 frames a second instead of 60
while the keyboard is open. This mod:
  - adds part 128 "keys_board" to keyboard.nxr: one cell (cell 21, animation 20 of keyboard_parts)
    holding the picture of every key at rest, at depth 17, behind the keys (16);
  - marks the keys: depth 16.000244 instead of 16 (one 1/4096 step, nothing to see);
  - rewrites the parts' update and draw (ARM9 0x0207DF30, patches/fast_keyboard.json): a marked
    part at rest (state 0) is neither animated nor drawn. A pressed key (state 1, Shift held) or a
    disabled one (state 2) is still drawn, over the picture.
The keys still take the touches: the keyboard tests their positions, not what is drawn. The
Online Arena's keypad (make_online_patch.py) hides the picture and unmarks the keys while it is
open. The files are written under <mod dir> (default mod/) with their NitroFS path, for
nds_tool.py repack. With a preview path, the picture is also saved there as PNG.
Needs keystone-engine (pip install keystone-engine).
"""
import json
import math
import os
import struct
import sys

from keystone import KS_ARCH_ARM, KS_MODE_ARM, Ks
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sprite_tool as st  # noqa: E402
from nds_tool import code_region  # noqa: E402

LAYOUT = "ui/keyboard.nxr"
PARTS = "ui/keyboard_parts"
KEY_DEPTH = 16.0
MARKED_DEPTH = 16.0 + 1 / 4096   # the game keeps -depth in 20.12 fixed point: -0x10001
BOARD_DEPTH = 17.0
FIRST_KEY, LAST_KEY, BOARD = 71, 127, 128   # make_online_patch.py's keypad uses these too
PART_STEP = 0x2046E90   # animate a part's cell (r0 = cell animation, r1 = speed)
PART_DRAW = 0x2046804   # queue a part's cell for drawing (r0 = cell animation)
UPDATE = 0x0207DF30     # part update (r0 = part), then part draw at UPDATE + 0x28, up to 0x0207DF7C
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "patches", "fast_keyboard.json")

# Part: +0x08 -depth (20.12), +0x28 cell animation (+0x17 there = state: 0 rest, 1 pressed,
# 2 disabled), +0xFC shown, +0xFD has a cell. One instruction per line; the draw entry stays at
# UPDATE + 0x28 (line 10).
CODE = ("mov ip, #1\n"                      # update
        "check: ldrb r2, [r0, #0xfc]\nldrb r3, [r0, #0xfd]\nands r2, r2, r3\nbxeq lr\n"
        "ldr r3, [r0, #8]\nldrb r2, [r0, #0x3f]\nadd r0, r0, #0x28\nadd r3, r3, #0x10000\nb rest\n"
        "mov ip, #0\nb check\n"             # draw
        "rest: cmn r3, #1\ncmpeq r2, #0\nbxeq lr\n"
        f"cmp ip, #0\nbeq {PART_DRAW:#x}\nmov r1, #0x1000\nb {PART_STEP:#x}\n")


def section(data, magic):
    """Offset of a Nitro file's section (its header: magic, size)."""
    off = struct.unpack_from("<H", data, 12)[0]
    for _ in range(struct.unpack_from("<H", data, 14)[0]):
        if data[off:off + 4] == magic:
            return off
        off += struct.unpack_from("<I", data, off + 4)[0]
    raise SystemExit("no %s section" % magic.decode())


def keyboard_items(nxr):
    """(count offset, list of (offset of the item's fields, name, fields)) of an NXSR layout."""
    count, nres = struct.unpack_from("<II", nxr, 8)
    off = 16
    items = []

    def name():
        nonlocal off
        n = struct.unpack_from("<I", nxr, off)[0]
        s = nxr[off + 4:off + 4 + n].decode("ascii")
        off += 4 + ((n + 3) & ~3)
        return s

    for _ in range(nres):
        name()
    for _ in range(count):
        n = name()
        items.append((off, n, struct.unpack_from("<iIffffff4B", nxr, off)))
        off += 36
    return items


def board_picture(fs, items):
    """Palette indices of every key at rest, as the game places them: (x0, y0, rows)."""
    chars, bpp, tiled = st.read_chars(os.path.join(fs, PARTS + ".ncbr"))
    cells, unit = st.read_cells(os.path.join(fs, PARTS + ".ncer"))
    anims = st.read_anims(os.path.join(fs, PARTS + ".nanr"))
    obj_pixels = st.pixel_reader(chars, bpp, tiled)
    pixels = {}
    for _, _, (res, anim, x, y, *_rest) in items[FIRST_KEY:LAST_KEY + 1]:
        cell = cells[anims[anim][0][0]]
        for obj in cell["objs"]:
            px = obj_pixels(cell["src"] + obj["tile"] * unit, obj["w"], obj["h"])
            for yy in range(obj["h"]):
                for xx in range(obj["w"]):
                    v = px[yy][xx]
                    if v:
                        sx = obj["w"] - 1 - xx if obj["hflip"] else xx
                        sy = obj["h"] - 1 - yy if obj["vflip"] else yy
                        at = (round(x) + obj["x"] + sx, round(y) + obj["y"] + sy)
                        assert pixels.get(at, v) == v, "two keys overlap at %s" % (at,)
                        pixels[at] = v
    x0, y0 = min(p[0] for p in pixels), min(p[1] for p in pixels)
    x1, y1 = max(p[0] for p in pixels) + 1, max(p[1] for p in pixels) + 1
    return x0, y0, [[pixels.get((x, y), 0) for x in range(x0, x1)] for y in range(y0, y1)]


def tile_picture(rows):
    """Cut the picture into sprites: [(x, y, w, h)], skipping the empty ones."""
    height, width = len(rows), len(rows[0])
    objs, y = [], 0
    while y < height:
        left = height - y
        h = 64 if left > 32 else 32 if left > 16 else 16 if left > 8 else 8
        w = 64 if h >= 32 else 32
        for x in range(0, width, w):
            if any(v for r in rows[y:y + h] for v in r[x:x + w]):
                objs.append((x, y, w, h))
        y += h
    return objs


def obj_bitmap(rows, x, y, w, h):
    """4bpp linear bitmap of one sprite (first pixel in the low nibble), as keyboard_parts.ncbr."""
    px = [rows[yy][xx] if yy < len(rows) and xx < len(rows[0]) else 0
          for yy in range(y, y + h) for xx in range(x, x + w)]
    return bytes(px[i] | px[i + 1] << 4 for i in range(0, len(px), 2))


def obj_attrs(x, y, w, h, tile):
    """OAM attributes 0-2 of a 4bpp sprite (palette 0)."""
    shape, size = next((s, z) for s, row in enumerate(st.OBJ_SIZES) for z, wh in enumerate(row) if wh == (w, h))
    return struct.pack("<HHH", (y & 0xFF) | shape << 14, (x & 0x1FF) | size << 14, tile)


def add_chars(ncbr, data):
    """Append pixels to an NCBR; return (new file, first unit of the new pixels)."""
    off = section(ncbr, b"RAHC")
    size, data_off = struct.unpack_from("<II", ncbr, off + 0x18)
    unit = 64
    assert size % unit == 0
    out = bytearray(ncbr[:off + 8 + data_off + size] + data + ncbr[off + 8 + data_off + size:])
    struct.pack_into("<I", out, off + 4, struct.unpack_from("<I", ncbr, off + 4)[0] + len(data))
    struct.pack_into("<I", out, off + 0x18, size + len(data))
    struct.pack_into("<I", out, 8, len(out))
    return bytes(out), size // unit


def add_cell(ncer, oams, width, height):
    """Append a cell (OAM attributes, bounding box from its anchor) to an NCER; return the file."""
    off = section(ncer, b"KBEC")
    o = off + 8
    count, attr, cells_off = struct.unpack_from("<HHI", ncer, o)
    assert attr & 1, "cells without bounding boxes"
    table_end = o + cells_off + count * 16
    oam_end = off + struct.unpack_from("<I", ncer, off + 4)[0]
    radius = min(63, math.ceil(math.hypot(width, height) / 4))
    entry = struct.pack("<HHIhhhh", len(oams), 0x800 | radius, oam_end - table_end, width, height, 0, 0)
    out = bytearray(ncer[:table_end] + entry + ncer[table_end:oam_end] + b"".join(oams) + ncer[oam_end:])
    struct.pack_into("<H", out, o, count + 1)
    struct.pack_into("<I", out, off + 4, oam_end - off + 16 + 6 * len(oams))
    struct.pack_into("<I", out, 8, len(out))
    return bytes(out), count


def add_anim(nanr, cell):
    """Append a one-frame animation of `cell` to an NANR (index cells, as keyboard_parts.nanr)."""
    off = section(nanr, b"KNBA")
    o = off + 8
    nseq, nframes, seq_off, frame_off, key_off = struct.unpack_from("<HHIII", nanr, o)
    seqs = nanr[o + seq_off:o + frame_off]
    frames = nanr[o + frame_off:o + key_off]
    keys = nanr[o + key_off:o + key_off + 2 * nframes]
    assert struct.unpack_from("<HHHHI", seqs, 0) == (1, 0, 0, 1, 1), "unexpected sequence format"
    seqs += struct.pack("<HHHHII", 1, 0, 0, 1, 1, len(frames))
    frames += struct.pack("<IHH", len(keys), 2, 0xBEEF)
    keys += struct.pack("<H", cell)
    head = bytearray(nanr[o:o + seq_off])
    struct.pack_into("<HHIII", head, 0, nseq + 1, nframes + 1, seq_off, seq_off + len(seqs),
                     seq_off + len(seqs) + len(frames))
    body = bytes(head) + seqs + frames + keys
    out = bytearray(nanr[:o] + body + b"\xcc" * (-len(body) % 4))
    struct.pack_into("<I", out, 8, len(out))
    return bytes(out), nseq


def add_board(nxr, items, anim, x, y):
    """Mark the keys' depth and append the board part to the layout."""
    out = bytearray(nxr)
    for off, name, fields in items[FIRST_KEY:LAST_KEY + 1]:
        assert fields[0] == 0 and fields[4] == KEY_DEPTH, "%s is not a key" % name
        struct.pack_into("<f", out, off + 16, MARKED_DEPTH)
    assert all(f[4] != KEY_DEPTH for _, _, f in items[:FIRST_KEY]) and len(items) == BOARD
    name = b"keys_board"
    out += struct.pack("<I", len(name)) + name + b"\0" * (-len(name) % 4)
    out += struct.pack("<iIffffff4B", 0, anim, x, y, BOARD_DEPTH, 0.0, 1.0, 1.0, 255, 255, 255, 255)
    struct.pack_into("<I", out, 8, BOARD + 1)
    return bytes(out)


def main():
    if len(sys.argv) not in (3, 4, 5):
        print(__doc__)
        sys.exit(1)
    fs, rom = sys.argv[1], open(sys.argv[2], "rb").read()
    mod = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), "..", "mod")
    read = lambda name: open(os.path.join(fs, name), "rb").read()

    nxr = read(LAYOUT)
    items = keyboard_items(nxr)
    x0, y0, rows = board_picture(fs, items)
    objs = tile_picture(rows)
    ncbr, first = add_chars(read(PARTS + ".ncbr"), b"".join(obj_bitmap(rows, *o) for o in objs))
    oams, unit = [], first
    for x, y, w, h in objs:
        oams.append(obj_attrs(x, y, w, h, unit))
        unit += w * h // 2 // 64
    ncer, cell = add_cell(read(PARTS + ".ncer"), oams, len(rows[0]), len(rows))
    nanr, anim = add_anim(read(PARTS + ".nanr"), cell)
    files = {LAYOUT: add_board(nxr, items, anim, x0, y0), PARTS + ".ncbr": ncbr,
             PARTS + ".ncer": ncer, PARTS + ".nanr": nanr}
    for name, data in files.items():
        os.makedirs(os.path.dirname(os.path.join(mod, name)), exist_ok=True)
        with open(os.path.join(mod, name), "wb") as f:
            f.write(data)
    print("picture %dx%d at (%d, %d): %d sprites, %d bytes of pixels; cell %d, animation %d"
          % (len(rows[0]), len(rows), x0, y0, len(objs), sum(w * h // 2 for _, _, w, h in objs), cell, anim))

    if len(sys.argv) > 4:
        palette = st.read_palette(os.path.join(fs, PARTS + ".nclr"))
        img = Image.new("RGBA", (len(rows[0]), len(rows)))
        img.putdata([palette[v] + (255,) if v else (0, 0, 0, 0) for r in rows for v in r])
        img.save(sys.argv[4])

    start, ram, _ = code_region(rom, None)
    code = bytes(Ks(KS_ARCH_ARM, KS_MODE_ARM).asm(CODE, UPDATE)[0])
    assert len(code) == 0x4C and CODE.split("\n")[10] == "mov ip, #0", "the draw entry moved"
    doc = {"description": __doc__.split("\n\n")[0] + " " + " ".join(__doc__.split("\n\n")[2].split()),
           "patches": [{"address": f"{UPDATE:#010x}",
                        "original": rom[start + UPDATE - ram:start + UPDATE - ram + len(code)].hex(),
                        "replacement": code.hex(),
                        "comment": "keyboard part update and draw (draw entry still at 0x0207df58): a key "
                                   "at rest (depth mark -0x10001, state 0) is neither animated nor drawn; "
                                   "the keys_board part draws them all"}]}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print("1 patch -> %s" % os.path.abspath(OUT))


if __name__ == "__main__":
    main()
