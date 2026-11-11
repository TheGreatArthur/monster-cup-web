"""Export the game graphics of the story intro a new account watches once (web/public/story.js).

  python tools/export_story_assets.py <extracted NitroFS dir> [out dir]

<extracted NitroFS dir> is the output of `nds_tool.py extract`. The default out dir is
web/game-assets/story/. Like the other site graphics they stay local and are never shared; this
folder is served to logged-in players only. The intro also uses the starter page's font, window
and backgrounds (export_starter_assets.py) and the intro page's stadium and logo (export_site_assets.py).

story/ holds:
  fighters/<sprite>.png   one sheet per Digimon: a row per move of MOVES, a column per frame
  field_*.png             battle grounds (field/battle_*.nbs): a 384x288 map, seen through the
                          256x192 top screen
  vs.png                  the bottom screen of a battle: title plate, team plates, timer, pedestals
  digits.png              the battle timer's red digits 0-9, side by side
  story.json              per Digimon its name, frame size, anchor and move timings; the VS
                          screen's anchors
"""
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sprite_tool  # noqa: E402
from export_site_assets import export_fighter, render_nbs, screen  # noqa: E402

# (sprite file, name in the game's text). The developer's team, its rivals in the final, and the
# sparring Rookies of the training scene.
FIGHTERS = [
    ("m538_apollomon", "Apollomon"), ("m539_dianamon", "Dianamon"), ("m527_mugendramon", "Machinedramon"),
    ("m503_warglaymon", "WarGreymon"), ("m529_metalgarurumon_va", "MetalGarurumon"), ("m541_dukemon", "Gallantmon"),
    ("m201_agumon", "Agumon"), ("m208_gabumon", "Gabumon"),
]
# Animation sequences of a field sprite (every species has the same 40): standing, running, hit,
# thrown back, four attacks (wind-up then strike), knocked out, victory, and the white silhouette
# the game flashes on a hit.
MOVES = {"idle": 0, "run": 3, "hit": 4, "knock": 5, "atk1": 7, "atk2": 8, "atk3": 9, "atk4": 10,
         "ko": 13, "win": 33, "flash": 39}
FIELDS = {"field_grass": "field/battle_01_01", "field_stone": "field/battle_15_01"}
VS = "battle/battle_bg_sub"
VS_LAYOUT = "battle/battle_sub_scene.nxr"     # where the title, team names and timer digits go
DIGITS = "battle/battle_obj_sub"              # cells 0-9: the timer's digits


def export_digits(src, out):
    """The timer's digits 0-9 in one row of equal cells; return the cell size."""
    chars, bpp, tiled, palette, cells, unit = sprite_tool.load(os.path.join(src, DIGITS))
    imgs = [sprite_tool.render_cell(cells[d], unit, chars, bpp, tiled, palette) for d in range(10)]
    boxes = [im.getbbox() for im in imgs]
    box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    w, h = box[2] - box[0], box[3] - box[1]
    sheet = Image.new("RGBA", (w * 10, h))
    for d, im in enumerate(imgs):
        sheet.paste(im.crop(box), (d * w, 0))
    sheet.save(out)
    return {"image": "digits.png", "width": w, "height": h}


def main():
    if len(sys.argv) not in (2, 3):
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) == 3 else os.path.join(os.path.dirname(__file__), "..", "web", "game-assets", "story")
    os.makedirs(os.path.join(out, "fighters"), exist_ok=True)

    fighters = {}
    for sprite, name in FIGHTERS:
        entry = export_fighter(src, sprite, os.path.join(out, "fighters", sprite + ".png"), MOVES)
        fighters[sprite] = {"name": name, "image": "fighters/%s.png" % sprite, **entry}
    for key, base in FIELDS.items():
        render_nbs(os.path.join(src, base)).save(os.path.join(out, key + ".png"))
    screen(src, VS).save(os.path.join(out, "vs.png"))
    _, items = sprite_tool.read_layout(os.path.join(src, VS_LAYOUT))
    manifest = {
        "fighters": fighters,
        "fields": {key: key + ".png" for key in FIELDS},
        "vs": {"image": "vs.png", "anchors": {i["name"]: [i["x"], i["y"]] for i in items}},
        "digits": export_digits(src, os.path.join(out, "digits.png")),
    }
    with open(os.path.join(out, "story.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print("%d fighters, %d fields, VS screen -> %s" % (len(fighters), len(FIELDS), os.path.abspath(out)))


if __name__ == "__main__":
    main()
