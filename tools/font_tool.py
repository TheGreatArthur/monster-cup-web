"""Export a Nitro font (.NFTR) as a glyph sheet PNG + JSON metrics, for drawing game text on the web.

  python tools/font_tool.py <font.NFTR> <out.png> <out.json>

The PNG holds every glyph cell side by side; each pixel's grey level is the glyph's colour index
(1..3 for a 2 bpp font) stored in the red channel, alpha 255 where the index is not 0, so a page can
recolour the text with the game's palette. The JSON gives the cell size and, per character,
[cell index, left, glyph width, advance].
"""
import json
import struct
import sys

from PIL import Image


def read_font(path):
    b = open(path, "rb").read()
    assert b[:4] == b"RTFN", "not an NFTR font"
    off = struct.unpack_from("<H", b, 12)[0]
    finf = off + 8
    line_height = b[finf + 1]
    cglp, cwdh, cmap = struct.unpack_from("<III", b, finf + 8)

    cell_w, cell_h, cell_size, baseline, _, bpp = struct.unpack_from("<BBHBBB", b, cglp)
    cglp_size = struct.unpack_from("<I", b, cglp - 4)[0]
    count = (cglp_size - 16) // cell_size
    glyphs = []
    for g in range(count):
        data = b[cglp + 8 + g * cell_size:cglp + 8 + (g + 1) * cell_size]
        bits = int.from_bytes(data, "big")
        total = cell_size * 8
        px = []
        for i in range(cell_w * cell_h):
            shift = total - (i + 1) * bpp
            px.append((bits >> shift) & ((1 << bpp) - 1))
        glyphs.append(px)

    widths = {}
    while cwdh:
        first, last, nxt = struct.unpack_from("<HHI", b, cwdh)
        for i in range(last - first + 1):
            left, width, advance = struct.unpack_from("<bBB", b, cwdh + 8 + i * 3)
            widths[first + i] = (left, width, advance)
        cwdh = nxt

    chars = {}
    while cmap:
        first, last, kind, nxt = struct.unpack_from("<HHHxxI", b, cmap)
        data = cmap + 12
        if kind == 0:
            base = struct.unpack_from("<H", b, data)[0]
            for c in range(first, last + 1):
                chars[c] = base + c - first
        elif kind == 1:
            for i, c in enumerate(range(first, last + 1)):
                g = struct.unpack_from("<H", b, data + i * 2)[0]
                if g != 0xFFFF:
                    chars[c] = g
        else:
            n = struct.unpack_from("<H", b, data)[0]
            for i in range(n):
                c, g = struct.unpack_from("<HH", b, data + 2 + i * 4)
                chars[c] = g
        cmap = nxt
    return {"cell": (cell_w, cell_h), "baseline": baseline, "line_height": line_height, "bpp": bpp,
            "glyphs": glyphs, "widths": widths, "chars": chars}


def export(path, out_png, out_json):
    font = read_font(path)
    cw, ch = font["cell"]
    sheet = Image.new("RGBA", (cw * len(font["glyphs"]), ch))
    for g, px in enumerate(font["glyphs"]):
        for i, v in enumerate(px):
            if v:
                sheet.putpixel((g * cw + i % cw, i // cw), (v, v, v, 255))
    sheet.save(out_png)
    chars = {}
    for c, g in font["chars"].items():
        left, width, advance = font["widths"].get(g, (0, cw, cw))
        chars[chr(c)] = [g, left, width, advance]
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"cellWidth": cw, "cellHeight": ch, "baseline": font["baseline"],
                   "lineHeight": font["line_height"], "bpp": font["bpp"], "chars": chars}, f, ensure_ascii=False)
    return font


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    f = export(*sys.argv[1:])
    print("%d glyphs, %dx%d cells, %d bpp, %d characters" % (len(f["glyphs"]), *f["cell"], f["bpp"], len(f["chars"])))
