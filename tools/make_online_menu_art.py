"""Redraw the Multi Battle menu's labels for the in-game Online Arena (see make_online_patch.py).

  python tools/make_online_menu_art.py <extracted NitroFS dir> [mod dir] [preview dir]

The Nintendo Wi-Fi Connection screen becomes the Online Arena: its title banner and three of the
menu's button labels are redrawn with letters cut from the game's own banners and labels:

  ui/battle_title_obj_sub.ncgr     cell 78 "Nintendo Wi-Fi Connection" -> "Online Arena"
  battle_menu_net/net_obj_main.ncbr
    cell 12 (label 0)  "Nintendo Wi-Fi Connection"  -> "Create Room"
    cell 13 (label 1)  "Wireless Exchange"          -> "Join Room"
    cell 29 (label 17) "DS Wireless Communications" -> "Ranked Match"

No label has a "k": it is drawn here in the labels' 3-pixel stroke. The files are written under
<mod dir> (default mod/) with their NitroFS path, for nds_tool.py repack. With a preview dir, the
new banner and labels are also saved there as PNG.
"""
import os
import struct
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sprite_tool as st  # noqa: E402

TITLE_FILE = "ui/battle_title_obj_sub"
TITLE_CELL = 78
TITLE_TEXT = "Online Arena"
# Banner letters: (cell, first column, last column), columns counted from the cell's left edge.
# The banner font is anti-aliased and its letters share their outline column, so neighbours
# overlap by one column when they are put back together.
TITLE_GLYPHS = {
    "O": (48, 3, 14), "r": (48, 14, 21),                      # "Origin Survivor"
    "A": (47, 5, 18), "n": (47, 18, 27), "i": (47, 36, 40),   # "Ancient Busters"
    "e": (47, 40, 49),
    "l": (73, 28, 31), "a": (73, 60, 69),                     # "Multi Battle"
}
TITLE_SPACE = 4

LABEL_FILE = "battle_menu_net/net_obj_main"
LABELS = {12: "Create Room", 13: "Join Room", 29: "Ranked Match"}
# Label letters (bold font of "Friend Manager"): (cell, first column, last column).
LABEL_GLYPHS = {
    "C": (22, 101, 112), "o": (22, 114, 123), "d": (22, 125, 134), "e": (22, 136, 145),
    "M": (15, 59, 70), "a": (15, 72, 80), "n": (15, 34, 42), "r": (15, 11, 17), "i": (15, 19, 21),
    "m": (23, 53, 65), "t": (24, 23, 30), "R": (21, 64, 75), "c": (13, 100, 109),
    "h": (13, 111, 119), "J": (20, 24, 31),
}
K_GLYPH = [  # rows 2..14 of a 16-pixel label
    "###......",
    "###......",
    "###......",
    "###...###",
    "###..###.",
    "###.###..",
    "######...",
    "#####....",
    "######...",
    "###.###..",
    "###..###.",
    "###...###",
    "###...###",
]
LABEL_SPACE = 5


def cell_box(cell):
    x0 = min(o["x"] for o in cell["objs"])
    y0 = min(o["y"] for o in cell["objs"])
    x1 = max(o["x"] + o["w"] for o in cell["objs"])
    y1 = max(o["y"] + o["h"] for o in cell["objs"])
    return x0, y0, x1, y1


def read_cell(art, i):
    """The cell's pixels (palette indices) as rows, from its top-left corner."""
    chars, bpp, tiled, _, cells, unit = art
    pixels = st.pixel_reader(chars, bpp, tiled)
    cell = cells[i]
    x0, y0, x1, y1 = cell_box(cell)
    m = [[0] * (x1 - x0) for _ in range(y1 - y0)]
    for o in cell["objs"]:
        for y, row in enumerate(pixels(cell["src"] + o["tile"] * unit, o["w"], o["h"])):
            m[o["y"] - y0 + y][o["x"] - x0:o["x"] - x0 + o["w"]] = row
    return m


def write_cell(art, data, i, m):
    """Write rows of palette indices (cell-sized) into the cell's objects in `data`."""
    _, bpp, tiled, _, cells, unit = art
    cell = cells[i]
    x0, y0, _, _ = cell_box(cell)
    for o in cell["objs"]:
        start = cell["src"] + o["tile"] * unit
        for yy in range(o["h"]):
            for xx in range(o["w"]):
                if tiled:
                    idx = ((yy // 8) * (o["w"] // 8) + xx // 8) * 64 + (yy % 8) * 8 + xx % 8
                else:
                    idx = yy * o["w"] + xx
                v = m[o["y"] - y0 + yy][o["x"] - x0 + xx]
                if bpp == 8:
                    data[start + idx] = v
                else:
                    b = start + idx // 2
                    data[b] = (data[b] & 0x0F) | (v << 4) if idx & 1 else (data[b] & 0xF0) | v


def check_not_shared(art, ids):
    """The redrawn cells must not lend their pixels to any other cell."""
    _, bpp, _, _, cells, unit = art
    used = {}
    for ci, cell in enumerate(cells):
        for o in cell["objs"]:
            start = cell["src"] + o["tile"] * unit
            for b in range(start, start + o["w"] * o["h"] * bpp // 8, 32):
                used.setdefault(b, set()).add(ci)
    for blocks in used.values():
        if blocks & set(ids) and len(blocks) > 1:
            sys.exit(f"cells {sorted(blocks)} share pixels")


def compose(text, glyphs, space, overlap, height):
    """Lay glyphs (column lists) side by side; overlapping columns keep the higher index."""
    cols = []
    for ch in text:
        if ch == " ":
            cols += [[0] * height for _ in range(space)]
            continue
        g = glyphs[ch]
        if cols and overlap:
            for k in range(overlap):
                cols[-overlap + k] = [max(a, b) for a, b in zip(cols[-overlap + k], g[k])]
            cols += g[overlap:]
        else:
            if cols:
                cols.append([0] * height)
            cols += g
    return cols


def cut(art, cell, a, b):
    m = read_cell(art, cell)
    return [[m[y][x] for y in range(len(m))] for x in range(a, b + 1)]


def place(cols, width, height, center):
    """Columns into a width x height grid, centred or left-aligned."""
    left = (width - len(cols)) // 2 if center else 0
    if len(cols) > width:
        sys.exit("text too wide")
    m = [[0] * width for _ in range(height)]
    for x, col in enumerate(cols):
        for y, v in enumerate(col):
            m[y][left + x] = v
    return m


def preview(m, palette, base, path):
    img = Image.new("RGBA", (len(m[0]), len(m)), (24, 40, 90, 255))
    for y, row in enumerate(m):
        for x, v in enumerate(row):
            if v:
                img.putpixel((x, y), palette[base + v] + (255,))
    img.resize((img.width * 3, img.height * 3), Image.NEAREST).save(path)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    fs = sys.argv[1]
    mod = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "mod")
    shots = sys.argv[3] if len(sys.argv) > 3 else None

    # Banner
    art = st.load(os.path.join(fs, TITLE_FILE))
    check_not_shared(art, [TITLE_CELL])
    glyphs = {ch: cut(art, *src) for ch, src in TITLE_GLYPHS.items()}
    x0, y0, x1, y1 = cell_box(art[4][TITLE_CELL])
    m = place(compose(TITLE_TEXT, glyphs, TITLE_SPACE, 1, y1 - y0), x1 - x0, y1 - y0, center=True)
    path = os.path.join(fs, TITLE_FILE + ".ncgr")
    raw = bytearray(open(path, "rb").read())
    data_at = st.sections(path)["RAHC"][1] + 8 + struct.unpack_from("<I", raw, st.sections(path)["RAHC"][1] + 8 + 20)[0]
    chars = bytearray(art[0])
    write_cell(art, chars, TITLE_CELL, m)
    raw[data_at:data_at + len(chars)] = chars
    out = os.path.join(mod, TITLE_FILE + ".ncgr")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(raw)
    if shots:
        preview(m, art[3], art[4][TITLE_CELL]["objs"][0]["pal"] * 16, os.path.join(shots, "title_online_arena.png"))
    print("banner ->", os.path.abspath(out))

    # Button labels
    art = st.load(os.path.join(fs, LABEL_FILE))
    check_not_shared(art, list(LABELS))
    glyphs = {ch: cut(art, *src) for ch, src in LABEL_GLYPHS.items()}
    glyphs["k"] = [[0, 0] + [1 if row[x] == "#" else 0 for row in K_GLYPH] + [0] for x in range(len(K_GLYPH[0]))]
    path = os.path.join(fs, LABEL_FILE + ".ncbr")
    raw = bytearray(open(path, "rb").read())
    data_at = st.sections(path)["RAHC"][1] + 8 + struct.unpack_from("<I", raw, st.sections(path)["RAHC"][1] + 8 + 20)[0]
    chars = bytearray(art[0])
    for cell, text in LABELS.items():
        x0, y0, x1, y1 = cell_box(art[4][cell])
        m = place(compose(text, glyphs, LABEL_SPACE, 0, y1 - y0), x1 - x0, y1 - y0, center=False)
        write_cell(art, chars, cell, m)
        if shots:
            preview(m, art[3], 0, os.path.join(shots, "label_%s.png" % text.replace(" ", "_").lower()))
    raw[data_at:data_at + len(chars)] = chars
    out = os.path.join(mod, LABEL_FILE + ".ncbr")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(raw)
    print("labels ->", os.path.abspath(out))


if __name__ == "__main__":
    main()
