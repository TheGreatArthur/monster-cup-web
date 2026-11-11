"""Render Nitro sprites (NCLR palette + NCGR/NCBR pixels + NCER cells + NANR animations) to PNG.

  python tools/sprite_tool.py cells <base path> <out dir>
      <base path> is the file name without extension, e.g. extracted/digimon/m008_poyomon_main.
      Writes one PNG per cell (cell000.png, ...), cropped to the cell's bounding box.

  python tools/sprite_tool.py anim <base path> <sequence> <out.png>
      Writes the frames of one animation sequence side by side (a sprite sheet) and prints
      the frame durations (1/60 s) as JSON.

  python tools/sprite_tool.py bg <base path> <out.png>
      Renders a background (<base>.nscr tile map over <base>.ncgr, <base>.nclr).

  python tools/sprite_tool.py layout <scene.nxr> <out.png>
      Renders an NXSR scene layout (e.g. ui/alert_window.nxr) on a 256x192 screen and prints its items.

Pixels come from <base>.ncbr (linear, one bitmap per object) or <base>.ncgr (8x8 tiles).
When the cell bank has a VRAM transfer table, each cell's pixels start at its own offset.
"""
import json
import os
import struct
import sys

from PIL import Image

# OAM object sizes in pixels, by [shape][size].
OBJ_SIZES = [
    [(8, 8), (16, 16), (32, 32), (64, 64)],
    [(16, 8), (32, 8), (32, 16), (64, 32)],
    [(8, 16), (8, 32), (16, 32), (32, 64)],
]


def sections(path):
    """Return {magic: (data, offset of the section)} of a Nitro file."""
    b = open(path, "rb").read()
    out = {}
    off = struct.unpack_from("<H", b, 12)[0]
    for _ in range(struct.unpack_from("<H", b, 14)[0]):
        magic = b[off:off + 4].decode("ascii")
        size = struct.unpack_from("<I", b, off + 4)[0]
        out[magic] = (b, off)
        off += size
    return out


def read_palette(path):
    b, off = sections(path)["TTLP"]
    depth, _, size, data_off = struct.unpack_from("<IIII", b, off + 8)
    raw = b[off + 8 + data_off:off + 8 + data_off + size]
    colors = []
    for i in range(0, len(raw) - 1, 2):
        c = struct.unpack_from("<H", raw, i)[0]
        r, g, bl = c & 31, (c >> 5) & 31, (c >> 10) & 31
        colors.append((r * 255 // 31, g * 255 // 31, bl * 255 // 31))
    return colors


def read_chars(path):
    b, off = sections(path)["RAHC"]
    _, _, depth, _, tiling, size, data_off = struct.unpack_from("<HHIIIII", b, off + 8)
    bpp = 4 if depth == 3 else 8
    return b[off + 8 + data_off:off + 8 + data_off + size], bpp, not (tiling & 1)


def read_cells(path):
    b, off = sections(path)["KBEC"]
    o = off + 8
    count, attr, cells_off, mapping, vram_off = struct.unpack_from("<HHIII", b, o)
    entry = 16 if attr & 1 else 8
    oam_base = o + cells_off + count * entry
    transfers = None
    if vram_off:
        v = o + vram_off
        _, table = struct.unpack_from("<II", b, v)
        transfers = [struct.unpack_from("<II", b, v + table + i * 8) for i in range(count)]
    cells = []
    for i in range(count):
        n, _, oam_off = struct.unpack_from("<HHI", b, o + cells_off + i * entry)
        objs = []
        for k in range(n):
            a0, a1, a2 = struct.unpack_from("<HHH", b, oam_base + oam_off + k * 6)
            y = a0 & 0xFF
            y = y - 256 if y >= 128 else y
            x = a1 & 0x1FF
            x = x - 512 if x >= 256 else x
            w, h = OBJ_SIZES[a0 >> 14][a1 >> 14]
            objs.append({"x": x, "y": y, "w": w, "h": h, "tile": a2 & 0x3FF, "pal": a2 >> 12,
                         "hflip": bool(a1 & 0x1000), "vflip": bool(a1 & 0x2000), "bpp8": bool(a0 & 0x2000)})
        cells.append({"objs": objs, "src": transfers[i][0] if transfers else 0})
    return cells, 32 << mapping if mapping < 4 else 32


def read_anims(path):
    b, off = sections(path)["KNBA"]
    o = off + 8
    nseq, _, seq_off, frame_off, key_off = struct.unpack_from("<HHIII", b, o)
    seqs = []
    for i in range(nseq):
        nframes, _, _, _, _, frames_at = struct.unpack_from("<HHHHII", b, o + seq_off + i * 16)
        frames = []
        for f in range(nframes):
            key, duration = struct.unpack_from("<IH", b, o + frame_off + frames_at + f * 8)
            cell = struct.unpack_from("<H", b, o + key_off + key)[0]
            frames.append((cell, duration))
        seqs.append(frames)
    return seqs


def pixel_reader(chars, bpp, tiled):
    def obj_pixels(start, w, h):
        px = [[0] * w for _ in range(h)]
        for yy in range(h):
            for xx in range(w):
                if tiled:
                    tile = (yy // 8) * (w // 8) + xx // 8
                    idx = tile * 64 + (yy % 8) * 8 + xx % 8
                else:
                    idx = yy * w + xx
                if bpp == 4:
                    byte = chars[start + idx // 2] if start + idx // 2 < len(chars) else 0
                    px[yy][xx] = (byte >> 4) if idx & 1 else (byte & 15)
                else:
                    px[yy][xx] = chars[start + idx] if start + idx < len(chars) else 0
        return px
    return obj_pixels


def render_cell(cell, unit, chars, bpp, tiled, palette, box=(-64, -64, 64, 64)):
    """Render a cell on a canvas covering `box` (x0, y0, x1, y1), origin at the sprite anchor."""
    x0, y0, x1, y1 = box
    img = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    obj_pixels = pixel_reader(chars, bpp, tiled)
    for obj in reversed(cell["objs"]):   # the first object is drawn on top
        start = cell["src"] + obj["tile"] * unit
        px = obj_pixels(start, obj["w"], obj["h"])
        pal_base = obj["pal"] * 16 if bpp == 4 else 0
        for yy in range(obj["h"]):
            for xx in range(obj["w"]):
                v = px[yy][xx]
                if v == 0:
                    continue
                sx = obj["w"] - 1 - xx if obj["hflip"] else xx
                sy = obj["h"] - 1 - yy if obj["vflip"] else yy
                tx, ty = obj["x"] + sx - x0, obj["y"] + sy - y0
                if 0 <= tx < img.width and 0 <= ty < img.height:
                    img.putpixel((tx, ty), palette[pal_base + v] + (255,))
    return img


def render_bg(base):
    """Render a background: <base>.nscr tile map over <base>.ncgr tiles and <base>.nclr."""
    chars, bpp, _ = read_chars(base + ".ncgr")
    palette = read_palette(base + ".nclr")
    b, off = sections(base + ".nscr")["NRCS"]
    width, height, _, _, size = struct.unpack_from("<HHHHI", b, off + 8)
    img = Image.new("RGBA", (width, height))
    tile_bytes = 64 if bpp == 8 else 32
    for i in range(size // 2):
        e = struct.unpack_from("<H", b, off + 0x14 + i * 2)[0]
        tile, hflip, vflip, pal = e & 0x3FF, e & 0x400, e & 0x800, e >> 12
        tx, ty = (i % (width // 8)) * 8, (i // (width // 8)) * 8
        for yy in range(8):
            for xx in range(8):
                idx = tile * tile_bytes + (yy * 8 + xx if bpp == 8 else (yy * 8 + xx) // 2)
                v = chars[idx] if idx < len(chars) else 0
                if bpp == 4:
                    v = (v >> 4) if xx & 1 else (v & 15)
                    v += pal * 16
                sx = 7 - xx if hflip else xx
                sy = 7 - yy if vflip else yy
                img.putpixel((tx + sx, ty + sy), palette[v % len(palette)] + (255,))
    return img


def read_layout(path):
    """Parse an NXSR scene layout: (resource names, items).

    Each item: name, resource index (-1 for a text / touch anchor), animation, x, y, scale x, scale y.
    Sprite items show the first frame of animation `anim` of their resource (a sprite bank in the
    same folder), scaled from the top-left corner: the game stretches 8 px edge pieces this way.
    """
    b = open(path, "rb").read()
    assert b[:4] == b"NXSR"
    count, nres = struct.unpack_from("<II", b, 8)
    off = 16

    def name():
        nonlocal off
        n = struct.unpack_from("<I", b, off)[0]
        s = b[off + 4:off + 4 + n].decode("ascii")
        off += 4 + ((n + 3) & ~3)
        return s

    resources = [name() for _ in range(nres)]
    items = []
    for _ in range(count):
        item = {"name": name()}
        res, anim, x, y, _, _, sx, sy = struct.unpack_from("<iIffffff", b, off)
        off += 36
        item.update(res=res, anim=anim, x=x, y=y, sx=sx, sy=sy)
        items.append(item)
    return resources, items


def render_layout(path, size=(256, 192), skip=()):
    """Render the sprite items of an NXSR layout (first animation frame of each) on a canvas.
    Items named in `skip` are left out."""
    resources, items = read_layout(path)
    folder = os.path.dirname(path)
    banks = {}
    img = Image.new("RGBA", size)
    for item in reversed(items):          # the first item is drawn on top
        if item["res"] < 0 or item["name"] in skip:
            continue
        base = os.path.join(folder, resources[item["res"]])
        if base not in banks:
            banks[base] = load(base) + (read_anims(base + ".nanr"),)
        chars, bpp, tiled, palette, cells, unit, anims = banks[base]
        cell = cells[anims[item["anim"]][0][0]]
        sprite = render_cell(cell, unit, chars, bpp, tiled, palette, box=(0, 0, 128, 128))
        bbox = sprite.getbbox()
        if not bbox:
            continue
        sprite = sprite.crop((0, 0, bbox[2], bbox[3]))
        w, h = round(sprite.width * item["sx"]), round(sprite.height * item["sy"])
        sprite = sprite.resize((w, h), Image.NEAREST)
        img.alpha_composite(sprite, (round(item["x"]), round(item["y"])))
    return img


def load(base):
    char_path = base + ".ncbr" if os.path.exists(base + ".ncbr") else base + ".ncgr"
    chars, bpp, tiled = read_chars(char_path)
    palette = read_palette(base + ".nclr")
    cells, unit = read_cells(base + ".ncer")
    return chars, bpp, tiled, palette, cells, unit


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "cells" and len(sys.argv) == 4:
        chars, bpp, tiled, palette, cells, unit = load(sys.argv[2])
        os.makedirs(sys.argv[3], exist_ok=True)
        for i, cell in enumerate(cells):
            img = render_cell(cell, unit, chars, bpp, tiled, palette)
            bbox = img.getbbox()
            if bbox:
                img.crop(bbox).save(os.path.join(sys.argv[3], "cell%03d.png" % i))
        print("%d cells" % len(cells))
    elif cmd == "anim" and len(sys.argv) == 5:
        base, seq, out = sys.argv[2], int(sys.argv[3]), sys.argv[4]
        chars, bpp, tiled, palette, cells, unit = load(base)
        frames = read_anims(base + ".nanr")[seq]
        imgs = [render_cell(cells[c], unit, chars, bpp, tiled, palette) for c, _ in frames]
        # One common crop for every frame keeps the anchor in place.
        boxes = [im.getbbox() for im in imgs if im.getbbox()]
        box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
        w, h = box[2] - box[0], box[3] - box[1]
        sheet = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
        for i, im in enumerate(imgs):
            sheet.paste(im.crop(box), (i * w, 0))
        sheet.save(out)
        print(json.dumps({"width": w, "height": h, "durations": [d for _, d in frames]}))
    elif cmd == "bg" and len(sys.argv) == 4:
        render_bg(sys.argv[2]).save(sys.argv[3])
    elif cmd == "layout" and len(sys.argv) == 4:
        render_layout(sys.argv[2]).save(sys.argv[3])
        for item in read_layout(sys.argv[2])[1]:
            print(json.dumps(item))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
