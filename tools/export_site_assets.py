"""Export the game graphics of the site's pages: the intro / login page and the play page.

  python tools/export_site_assets.py <extracted NitroFS dir> [out dir]

<extracted NitroFS dir> is the output of `nds_tool.py extract`. The default out dir is
web/game-assets/. Like the starter's graphics (export_starter_assets.py) they stay local and are
never shared. The intro page shows before login, so the server serves its folder (intro/) to
everyone; the play page's graphics (site/) stay behind the login like the rest of game-assets/.

intro/ holds:
  logo.png             the title screen's logo (crown + "Digimon World Championship"), cut out of
                       its hexagon background, without the copyright lines
  arena.png            the title screen's background: the floating stadium over the hexagons
  hex.png              the menus' hexagon background, to tile
  ground_<name>.png    the battle grounds Digimon fight on in the game (GROUNDS), 384x288
  fighters/<sprite>.png     one sheet per Digimon: a row per move (MOVES), a column per frame
  fighters.json        the teams, the grounds and, per Digimon, its frame size, anchor, move
                       timings and the colour of its attack
site/ holds the play page's background.
"""
import json
import os
import struct
import sys
from collections import deque

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sprite_tool  # noqa: E402

# The Rookies fighting on the intro page, as famous rival duos: the page splits each duo between
# its two teams. (sprite file, name in the game's text, colour of its signature attack, drawn by
# the page as a glowing shot.)
DUOS = [
    (("m201_agumon", "Agumon", "#ff8a2a"), ("m208_gabumon", "Gabumon", "#5fd0ff")),
    (("m255_guilmon", "Guilmon", "#ff4a3a"), ("m237_renamon", "Renamon", "#c8f4ff")),
    (("m227_patamon", "Patamon", "#fff3a0"), ("m232_plotmon", "Salamon", "#ffc8ec")),
    (("m222_tentomon", "Tentomon", "#fff35a"), ("m228_palmon", "Palmon", "#9cff6a")),
    (("m219_gomamon", "Gomamon", "#5aa8ff"), ("m230_piyomon", "Biyomon", "#ff9a3a")),
    (("m238_coronamon", "Coronamon", "#ffb52a"), ("m239_lunamon", "Lunamon", "#c9a6ff")),
    (("m205_gaomon", "Gaomon", "#6ab6ff"), ("m231_falcomon", "Falcomon", "#e8c26a")),
]
# Animation sequences of a Digimon's field sprite (every species has the same 40), the ones a
# battle needs, as the game plays them: standing, running, taking a hit, knocked off its feet, the
# four attacks (wind-up frames, then the strike), lying knocked out, and the victory dance.
MOVES = {"idle": 0, "run": 3, "hit": 4, "knock": 5, "atk1": 7, "atk2": 8, "atk3": 9, "atk4": 10,
         "ko": 13, "win": 33}
# The game's battle grounds (field/battle_*: tile maps the battle scene scrolls under the fighters).
GROUNDS = {"grass": "field/battle_01_01", "rock": "field/battle_08_01", "stone": "field/battle_15_01"}

LOGO = ("title_menu/title_top", (0, 0, 256, 148))       # above the copyright lines
LOGO_SPECK = 40                                           # smaller leftovers of the background
ARENA = "title_menu/title_bg_main"
HEX = "ui/common_bg_top"
PLAY_BG = "title_menu/start_back_bg_main"                 # dark blue with circuit lines


def screen(src, bg):
    """The first 256x192 pixels of a background."""
    return sprite_tool.render_bg(os.path.join(src, bg)).crop((0, 0, 256, 192))


def export_fighter(src, sprite, out, moves=MOVES):
    """Write a fighter's sheet: one row per move of `moves` ({name: animation sequence}), every
    frame cropped to one common box so the anchor (the sprite's feet) stays at the same place.
    Return its manifest entry."""
    base = os.path.join(src, "digimon", sprite + "_main")
    chars, bpp, tiled, palette, cells, unit = sprite_tool.load(base)
    anims = sprite_tool.read_anims(base + ".nanr")
    box = (-64, -64, 64, 64)                 # render_cell's canvas, anchor at (64, 64)
    rows = {move: [(sprite_tool.render_cell(cells[c], unit, chars, bpp, tiled, palette, box), d)
                   for c, d in anims[seq]] for move, seq in moves.items()}
    boxes = [im.getbbox() for frames in rows.values() for im, _ in frames if im.getbbox()]
    crop = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    w, h = crop[2] - crop[0], crop[3] - crop[1]
    sheet = Image.new("RGBA", (w * max(len(f) for f in rows.values()), h * len(rows)))
    for r, frames in enumerate(rows.values()):
        for c, (im, _) in enumerate(frames):
            sheet.paste(im.crop(crop), (c * w, r * h))
    sheet.save(out)
    return {"width": w, "height": h, "anchor": [-box[0] - crop[0], -box[1] - crop[1]],
            "moves": {move: {"row": r, "durations": [d for _, d in frames]}
                      for r, (move, frames) in enumerate(rows.items())}}


def render_nbs(base):
    """Render a battle ground: <base>.nbs ("NBSR": width and height in tiles, then one u16 screen
    entry per tile, as in an NSCR) over <base>.ncgr and <base>.nclr."""
    chars, bpp, _ = sprite_tool.read_chars(base + ".ncgr")
    palette = sprite_tool.read_palette(base + ".nclr")
    b = open(base + ".nbs", "rb").read()
    assert b[:4] == b"NBSR"
    w, h = struct.unpack_from("<II", b, 8)
    img = Image.new("RGBA", (w * 8, h * 8))
    tile_bytes = 64 if bpp == 8 else 32
    for i in range(w * h):
        e = struct.unpack_from("<H", b, 0x14 + i * 2)[0]
        tile, hflip, vflip, pal = e & 0x3FF, e & 0x400, e & 0x800, e >> 12
        tx, ty = (i % w) * 8, (i // w) * 8
        for yy in range(8):
            for xx in range(8):
                idx = tile * tile_bytes + (yy * 8 + xx if bpp == 8 else (yy * 8 + xx) // 2)
                v = chars[idx] if idx < len(chars) else 0
                if bpp == 4:
                    v = ((v >> 4) if xx & 1 else (v & 15)) + pal * 16
                img.putpixel((tx + (7 - xx if hflip else xx), ty + (7 - yy if vflip else yy)),
                             palette[v % len(palette)] + (255,))
    return img


def cut_out_logo(img):
    """The logo is drawn on the same layer as the hexagons behind it, in the same blues. Its edge
    is closed all around, though: the crown's gold rim and the letters' near black outline. So
    the background is everything a flood from the image's edges reaches without crossing that
    rim; clear it, drop the specks left over, and crop."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size

    def background(x, y):
        r, g, b, _ = px[x, y]
        gold = r > 140 and g > 90 and b < r - 40
        dark = r + g + b < 130
        return not (gold or dark)

    clear = set()
    todo = deque([(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)])
    while todo:
        x, y = todo.popleft()
        if 0 <= x < w and 0 <= y < h and (x, y) not in clear and background(x, y):
            clear.add((x, y))
            todo.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    for x, y in clear:
        px[x, y] = (0, 0, 0, 0)

    seen = set()
    for start in [(x, y) for y in range(h) for x in range(w)]:
        if start in seen or px[start][3] == 0:
            continue
        part, todo = [], [start]
        seen.add(start)
        while todo:
            x, y = todo.pop()
            part.append((x, y))
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= n[0] < w and 0 <= n[1] < h and n not in seen and px[n][3]:
                    seen.add(n)
                    todo.append(n)
        if len(part) < LOGO_SPECK:
            for xy in part:
                px[xy] = (0, 0, 0, 0)
    return img.crop(img.getbbox())


def main():
    if len(sys.argv) not in (2, 3):
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) == 3 else os.path.join(os.path.dirname(__file__), "..", "web", "game-assets")
    intro, site = os.path.join(out, "intro"), os.path.join(out, "site")
    os.makedirs(os.path.join(intro, "fighters"), exist_ok=True)
    os.makedirs(site, exist_ok=True)

    cut_out_logo(sprite_tool.render_bg(os.path.join(src, LOGO[0])).crop(LOGO[1])).save(os.path.join(intro, "logo.png"))
    screen(src, ARENA).save(os.path.join(intro, "arena.png"))
    screen(src, HEX).save(os.path.join(intro, "hex.png"))
    for key, base in GROUNDS.items():
        render_nbs(os.path.join(src, base)).convert("RGB").save(os.path.join(intro, "ground_%s.png" % key))

    fighters = {}
    for duo in DUOS:
        for sprite, name, color in duo:
            entry = export_fighter(src, sprite, os.path.join(intro, "fighters", sprite + ".png"))
            fighters[sprite] = {"name": name, "color": color, "image": "fighters/%s.png" % sprite, **entry}
    manifest = {"duos": [[a[0], b[0]] for a, b in DUOS], "grounds": ["ground_%s.png" % k for k in GROUNDS],
                "fighters": fighters}
    with open(os.path.join(intro, "fighters.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)

    screen(src, PLAY_BG).save(os.path.join(site, "play_bg.png"))
    print("logo, %d grounds, %d fighters -> %s; play page -> %s" % (len(GROUNDS), len(fighters), os.path.abspath(intro), os.path.abspath(site)))


if __name__ == "__main__":
    main()
