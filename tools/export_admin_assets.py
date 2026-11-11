"""Export the game graphics of the admin pages (web/game-assets/admin/).

  python tools/export_admin_assets.py <extracted NitroFS dir> <rom.nds> [out dir]

<extracted NitroFS dir> is the output of `nds_tool.py extract` (the folder holding digimon/, ui/,
database/, ...). Writes digimon/<species>.png (first frame of every species, 0 is the DigiEgg), items/<item>.png
(the icon the game's menus show) and badges/<cup>.png (the medal of each of the 61 competitions).
The files are game graphics: they stay local and the web server serves them to logged-in users only.
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sprite_tool  # noqa: E402

ARM9_RAM = 0x02000000
SPECIES_TABLE, SPECIES_RECORD, SPECIES_FIRST, SPECIES_COUNT = 0x020C1D98, 0x84, 8, 220
ITEM_TABLE, ITEM_RECORD, ITEM_COUNT = 0x020E1694, 56, 118
CUPS = 61


def write_frame(base, sequence, frame, out):
    """Write one frame of an animation, cropped to its pixels. False when the sprite has none."""
    chars, bpp, tiled, palette, cells, unit = sprite_tool.load(base)
    anims = sprite_tool.read_anims(base + ".nanr")
    img = sprite_tool.render_cell(cells[anims[sequence][frame][0]], unit, chars, bpp, tiled, palette)
    box = img.getbbox()
    if not box:
        return False
    img.crop(box).save(out)
    return True


def main():
    if len(sys.argv) not in (3, 4):
        print(__doc__)
        sys.exit(1)
    src, rom_path = sys.argv[1:3]
    out = sys.argv[3] if len(sys.argv) == 4 else os.path.join(os.path.dirname(__file__), "..", "web", "game-assets", "admin")
    for folder in ("digimon", "items", "badges"):
        os.makedirs(os.path.join(out, folder), exist_ok=True)
    rom = open(rom_path, "rb").read()
    arm9 = struct.unpack_from("<I", rom, 0x20)[0]
    u32 = lambda addr: struct.unpack_from("<I", rom, arm9 + addr - ARM9_RAM)[0]
    def cstr(addr):
        start = arm9 + addr - ARM9_RAM
        return rom[start:rom.index(0, start)].decode("latin1")

    counts = {"digimon": 0, "items": 0, "badges": 0}
    missing = []
    for i in range(SPECIES_COUNT):
        sprite = cstr(u32(SPECIES_TABLE + i * SPECIES_RECORD + 4))
        try:
            counts["digimon"] += write_frame(os.path.join(src, "digimon", sprite + "_main"), 0, 0,
                                             os.path.join(out, "digimon", "%d.png" % (SPECIES_FIRST + i)))
        except FileNotFoundError:
            missing.append(sprite)
    counts["digimon"] += write_frame(os.path.join(src, "digimon", "e000_digitama_main"), 0, 0,
                                     os.path.join(out, "digimon", "0.png"))
    for i in range(ITEM_COUNT):
        # An item's fields start at word 5 of the record before its name: its menu tab (the
        # bank's animation, from 1 when it has several), its place in the tab and the bank.
        record = ITEM_TABLE + (i - 1) * ITEM_RECORD
        tab, place, bank = u32(record + 24), u32(record + 28), cstr(u32(record + 32))
        try:
            counts["items"] += write_frame(os.path.join(src, "ui", bank + "_main"), max(tab - 1, 0), place,
                                           os.path.join(out, "items", "%d.png" % i))
        except FileNotFoundError:
            missing.append(bank)
    for cup in range(CUPS):
        counts["badges"] += write_frame(os.path.join(src, "database", "item_badge%03d" % (cup + 1)), 0, 0,
                                        os.path.join(out, "badges", "%d.png" % cup))
    print(counts, "missing:", sorted(set(missing)))


if __name__ == "__main__":
    main()
