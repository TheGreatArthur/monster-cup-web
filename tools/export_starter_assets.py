"""Export the game graphics and fonts used by the starter selection page (web/game-assets/).

  python tools/export_starter_assets.py <extracted NitroFS dir> [out dir]

<extracted NitroFS dir> is the output of `nds_tool.py extract` (the folder holding digimon/,
ui/, title_menu/, common/font/, ...). The default out dir is web/game-assets/. The files are game
graphics: they stay local and the web server serves them to logged-in users only, like the ROM.
"""
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import font_tool  # noqa: E402
import sprite_tool  # noqa: E402

# The 12 Baby I species: (species id, name, sprite file). Species id = db_txt_list index + 8.
BABIES = [
    (0x08, "Zurumon", "m001_zurumon"),
    (0x09, "Choromon", "m002_choromon"),
    (0x0A, "Nyokimon", "m003_nyokimon"),
    (0x0B, "Pabumon", "m004_bubbmon"),
    (0x0C, "Pichimon", "m005_pitchmon"),
    (0x0D, "Punimon", "m006_punimon"),
    (0x0E, "Botamon", "m007_botamon"),
    (0x0F, "Poyomon", "m008_poyomon"),
    (0x10, "Mokumon", "m009_mokumon"),
    (0x11, "YukimiBotamon", "m010_yukimibotamon"),
    (0x12, "Yuramon", "m011_yuramon"),
    (0x13, "Petitmon", "m012_petimon"),
]
# Screen backgrounds of the game's menus (hexagon pattern), top and bottom screen.
BACKGROUNDS = {"bg_top": "ui/common_bg_top", "bg_bottom": "ui/common_bg_bottom"}
# Single sprite cells: (out name, sprite bank, cell index).
CELLS = [
    ("button", "title_menu/title_obj", 1),           # gold-framed button plate
    ("button_down", "title_menu/title_obj", 2),      # the same plate, pressed
    ("label_ok", "title_menu/title_obj", 36),        # "OK", gold
    ("label_yes", "ui/button_text", 15),
    ("label_no", "ui/button_text", 16),
    ("arrow", "battle_menu/battle_setting_obj_main", 11),   # red arrow (points down)
]
FONTS = {"font": "rodan_pro_db_12_u", "font_small": "digi_font_11_u"}
# The game's message window: ui/alert_window.nxr. Its black plane is drawn translucent in game.
WINDOW_LAYOUT = "ui/alert_window.nxr"
WINDOW_PLANE_ALPHA = 0xC0


def export_anim(base, seq, out):
    """Write animation `seq` of a sprite as a horizontal sheet; return {width, height, durations}."""
    chars, bpp, tiled, palette, cells, unit = sprite_tool.load(base)
    frames = sprite_tool.read_anims(base + ".nanr")[seq]
    imgs = [sprite_tool.render_cell(cells[c], unit, chars, bpp, tiled, palette) for c, _ in frames]
    boxes = [im.getbbox() for im in imgs if im.getbbox()]
    box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    w, h = box[2] - box[0], box[3] - box[1]
    sheet = Image.new("RGBA", (w * len(imgs), h))
    for i, im in enumerate(imgs):
        sheet.paste(im.crop(box), (i * w, 0))
    sheet.save(out)
    return {"width": w, "height": h, "durations": [d for _, d in frames]}


def export_cell(base, index, out):
    chars, bpp, tiled, palette, cells, unit = sprite_tool.load(base)
    img = sprite_tool.render_cell(cells[index], unit, chars, bpp, tiled, palette)
    img.crop(img.getbbox()).save(out)


def export_window(src, out):
    """Render the message window and return where it sits on the 256x192 screen and its anchors."""
    path = os.path.join(src, WINDOW_LAYOUT)
    _, items = sprite_tool.read_layout(path)
    plane = next(i for i in items if i["name"] == "bg_plane")
    screen = Image.new("RGBA", (256, 192))
    x, y = round(plane["x"]), round(plane["y"])
    screen.paste((0, 0, 0, WINDOW_PLANE_ALPHA), (x, y, x + round(8 * plane["sx"]), y + round(8 * plane["sy"])))
    screen.alpha_composite(sprite_tool.render_layout(path, skip=("bg_plane",)))
    box = screen.getbbox()
    screen.crop(box).save(out)
    anchors = {i["name"]: [i["x"], i["y"]] for i in items if i["res"] < 0}
    return {"x": box[0], "y": box[1], "anchors": anchors}


def main():
    if len(sys.argv) not in (2, 3):
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) == 3 else os.path.join(os.path.dirname(__file__), "..", "web", "game-assets")
    os.makedirs(out, exist_ok=True)
    manifest = {"babies": []}

    for species, name, sprite in BABIES:
        info = export_anim(os.path.join(src, "digimon", sprite + "_main"), 0, os.path.join(out, sprite + ".png"))
        manifest["babies"].append({"species": species, "name": name, "sprite": sprite + ".png", **info})
    manifest["egg"] = {"sprite": "digitama.png",
                       **export_anim(os.path.join(src, "digimon", "e000_digitama_main"), 0, os.path.join(out, "digitama.png"))}
    for key, bg in BACKGROUNDS.items():
        # These maps fill only the first 184 rows: tile them to cover the whole 192-row screen.
        img = sprite_tool.render_bg(os.path.join(src, bg))
        rows = img.convert("RGB").getbbox()[3]
        screen = Image.new("RGBA", (256, 192))
        for y in range(0, 192, rows):
            screen.paste(img.crop((0, 0, 256, rows)), (0, y))
        screen.save(os.path.join(out, key + ".png"))
        manifest[key] = key + ".png"
    for key, bank, index in CELLS:
        export_cell(os.path.join(src, bank), index, os.path.join(out, key + ".png"))
        manifest[key] = key + ".png"
    for key, font in FONTS.items():
        font_tool.export(os.path.join(src, "common", "font", font + ".NFTR"),
                         os.path.join(out, key + ".png"), os.path.join(out, key + ".json"))
        manifest[key] = {"image": key + ".png", "metrics": key + ".json"}
    manifest["window"] = {"image": "window.png", **export_window(src, os.path.join(out, "window.png"))}

    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print("%d babies, egg, window, buttons and fonts -> %s" % (len(BABIES), os.path.abspath(out)))


if __name__ == "__main__":
    main()
