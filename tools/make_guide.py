"""Build a PDF guide (English): every Digimon (sprite, level, attribute, type, base stats), its
digivolutions with their requirements, and every competition with its date and opponent team.

  python tools/make_guide.py <rom.nds> <extracted NitroFS dir> <out.pdf>

Data sources (read from the ROM, nothing typed by hand):
- Digimon table in ARM9 at 0x020C1D98: 220 records of 0x84 bytes, record i = species id i + 8
  (the first 216 are the Digimon of the database; the last 4 are battle-only copies). Fields used:
  +0x00 code name, +0x04 sprite file, +0x0C level (1 = In-Training I ... 6 = Mega),
  +0x10 attribute (index into db_txt_list 1154+), +0x18 type bit mask (bit k = db_txt_list 1160+k),
  +0x30..+0x37 u16 ranks of HP, TP, Attack, Defense, +0x38/+0x39 u8 ranks of Wisdom, Speed.
- Stat curves at 0x020CA60C: 25 rows of 8 u16 (HP, TP, Atk, Def, Wis, Spd, ...). A new Digimon gets
  curve[rank] plus a random bonus up to half of (curve[rank + 1] - curve[rank]) (ARM9 FUN_02060f68).
- Evolution table: 12-byte entries at 0x020E0620 (species 8 .. 0xBA), filled at boot by a static
  constructor from (source, destination) pointer pairs at 0x02099AC0. Entry = {target count, pointer
  to 60-byte target records, pointer to the pre-evolution list}. Record fields (offsets) as checked by
  overlay 18 FUN_ov018__0211a288, in list order, first full match wins:
  +0x00 target species; +0x04 = 1 for an end-of-life evolution (checked only when the life span runs
  out, else the Digimon degenerates to a DigiEgg); +0x06/+0x08/+0x0A minimum Vaccine/Data/Virus
  points; +0x0C..+0x1A minimum species points (EVO_SPECIES order); +0x1C..+0x30 stat minimums in % of
  the target's base curve (unused); +0x32 minimum battles; +0x34 minimum win rate %; +0x36 minimum
  Degen. to DigiEgg count; +0x38 injuries (maximum, or minimum on an end-of-life evolution).
- Tamer rank table at 0x020E323C (0x24 bytes per rank): +0x00 total capacity (G), +0x10 level the
  Digimon must be below to digivolve. Capacity (G) of a species = byte +0x1D of its record.
- Title matches at 0x020CD608: 62 records of 0x28 bytes: +0x00 name text, +0x04 description text,
  +0x08 opponent team, +0x0C entry rule (-1 none), +0x10 tier (listed once Tamer Rank >= 2 * tier,
  ARM9 0x02088A1C), +0x14 season (0 Spring .. 3 Winter), +0x18 day (0-7, 8 days per season).
  The first 61 are on the calendar; the last one is the tutorial match.
- Opponent teams at 0x020EEE64: records of 0x14 bytes: three member indexes, then the team name text.
  Members at 0x020E5564: records of 0x44 bytes, +0x00 species (0xE4 = empty slot) (overlay 10).
- Championship events: Preliminaries at 0x020AA210, Championship at 0x020AA200: {battle count, prize
  (bits, shown on the entry screen, ARM9 FUN_02096d70), ?, pointer to the battles}; battle = {u8 pool
  size, pointer to a pool of team records}. Overlay 10 FUN_ov010__02118518 picks one team of the
  battle's pool at random. The pools live in RAM: the static constructor at 0x0209A058 copies team
  records 71-98 into them at boot, so the tool runs it (unicorn) to read them.
  Rules (overlay 8 FUN_ov008__02114b48, ARM9 FUN_02096d70): reaching Tamer Rank 4 opens the
  Preliminaries; winning them qualifies for the Championship, held when (year & 3) == 3; winning
  it raises the Tamer Rank to 8 (Champ); Champ with all 61 titles won gives rank 9 (Master).
The PDF holds game graphics: keep it for personal use, do not publish it.
"""
import io
import json
import os
import re
import struct
import sys

from PIL import Image
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (Image as RLImage, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer,
                                Table, TableStyle)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sprite_tool  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ARM9_RAM = 0x02000000
TABLE = 0x020C1D98
RECORD = 0x84
COUNT = 216
CURVES = 0x020CA60C
STATS = ["HP", "TP", "ATK", "DEF", "WIS", "SPD"]
EVO_TABLE = 0x020E0620
EVO_INIT = 0x02099AC0
EVO_COUNT = 179
EVO_RECORD = 60
EVO_ATTRIBUTES = ["Vaccine", "Data", "Virus"]
EVO_SPECIES = ["Dragon", "Beast", "Aquatic", "Bird", "I.Plant", "Holy", "Dark", "Machine"]
RANKS = 0x020E323C
SHORT_LEVELS = {1: "Baby I", 2: "Baby II", 3: "Rookie", 4: "Champion", 5: "Ultimate", 6: "Mega"}
LEVELS = {1: "In-Training I", 2: "In-Training II", 3: "Rookie", 4: "Champion", 5: "Ultimate", 6: "Mega"}
TITLES = 0x020CD608
TITLE_RECORD = 0x28
TITLE_COUNT = 62
CALENDAR_TITLES = 61
TEAMS = 0x020EEE64
MEMBERS = 0x020E5564
MEMBER_RECORD = 0x44
EMPTY_SLOT = 0xE4
SEASONS = ["Spring", "Summer", "Autumn", "Winter"]
CHAMP_EVENTS = [(0x020AA210, 799, 801), (0x020AA200, 800, 802)]   # (record, name text, description text)
POOLS_INIT, POOLS_INIT_END = 0x0209A058, 0x0209A40C

NAVY = colors.HexColor("#0b1d45")
GOLD = colors.HexColor("#f8c830")
LIGHT = colors.HexColor("#eef3fb")
GRID = colors.HexColor("#c5cfe2")


def texts(name):
    entries = json.load(open(os.path.join(ROOT, "text", name), encoding="utf-8"))["entries"]
    return {e["id"]: e["text"] for e in entries}


def read_arm9(rom_path):
    rom = open(rom_path, "rb").read()
    off, _, load, size = struct.unpack_from("<IIII", rom, 0x20)
    assert load == ARM9_RAM
    return rom[off:off + size]


def digimon(arm9, db):
    def cstr(addr):
        o = addr - ARM9_RAM
        return arm9[o:arm9.index(b"\0", o)].decode("latin1")

    def curve(rank, col):
        return struct.unpack_from("<H", arm9, CURVES - ARM9_RAM + rank * 16 + col * 2)[0]

    out = []
    for i in range(COUNT):
        o = TABLE - ARM9_RAM + i * RECORD
        sprite = cstr(struct.unpack_from("<I", arm9, o + 4)[0])
        level, attribute = struct.unpack_from("<II", arm9, o + 0x0C)
        types = struct.unpack_from("<I", arm9, o + 0x18)[0]
        ranks = list(struct.unpack_from("<4H", arm9, o + 0x30)) + list(arm9[o + 0x38:o + 0x3A])
        stats = []
        for col, rank in enumerate(ranks):
            low = curve(rank, col)
            high = low + (curve(min(rank + 1, 24), col) - low) // 2
            stats.append((low, high))
        out.append({
            "species": i + 8, "name": db[i], "sprite": sprite, "level": level,
            "attribute": db[1154 + attribute],
            "types": "/".join(db[1160 + k] for k in range(8) if types >> k & 1) or "-",
            "stats": stats, "capacity": arm9[o + 0x1D],
        })
    return out


def evolutions(arm9):
    """{species: [(target, default, conditions)]} in the order the game checks them."""
    u32 = lambda addr: struct.unpack_from("<I", arm9, addr - ARM9_RAM)[0]
    entries = {}
    for k in range(EVO_COUNT):   # the static constructor copies each 12-byte entry from its source
        src, dst = u32(EVO_INIT + k * 8), u32(EVO_INIT + k * 8 + 4)
        entries[8 + (dst - EVO_TABLE) // 12] = struct.unpack_from("<3I", arm9, src - ARM9_RAM)
    out = {}
    for species, (count, records, _) in sorted(entries.items()):
        out[species] = []
        for k in range(count):
            r = struct.unpack_from("<I27H", arm9, records - ARM9_RAM + k * EVO_RECORD)
            target, default, f = r[0], r[1] == 1, r[2:]
            conds = [f"{name} min. {v}" for name, v in zip(EVO_ATTRIBUTES, f[0:3]) if v]
            conds += [f"{name} min. {v}" for name, v in zip(EVO_SPECIES, f[3:11]) if v]
            conds += [f"{name} min. {v} % of base" for name, v in zip(STATS + ["AP"] * 5, f[11:22]) if v]
            if f[22]:
                conds.append(f"Battles min. {f[22]}")
            if f[23]:
                conds.append(f"Win rate min. {f[23]} %")
            if f[24]:
                conds.append(f"DigiEgg min. {f[24]}x")
            if f[25]:
                conds.append(f"Injuries {'min.' if default else 'max.'} {f[25]}")
            out[species].append((target, default, conds))
    return out


def title_matches(arm9):
    """[{id, name, desc, season, day, tier, members}] in table order; members = opponent species."""
    def u32s(addr, n):
        return struct.unpack_from(f"<{n}i", arm9, addr - ARM9_RAM)

    out = []
    for k in range(TITLE_COUNT):
        name, desc, team, _, tier, season, day = u32s(TITLES + k * TITLE_RECORD, 7)
        *slots, team_name = u32s(TEAMS + team * 0x14, 4)
        members = [u32s(MEMBERS + s * MEMBER_RECORD, 1)[0] for s in slots]
        out.append({"id": k, "name": name, "desc": desc, "season": season, "day": day, "tier": tier,
                    "team": team_name, "members": [m for m in members if m != EMPTY_SLOT]})
    return out


def championship(arm9):
    """[{name, desc, prize, battles: [[{team, members}] pool per battle]}]: Preliminaries, Championship."""
    from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM
    from unicorn.arm_const import UC_ARM_REG_LR, UC_ARM_REG_SP

    # Run the static constructor that fills the battle pools, on a copy of ARM9 in emulated RAM.
    ram = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    ram.mem_map(ARM9_RAM, 0x400000)
    ram.mem_write(ARM9_RAM, arm9)
    ram.reg_write(UC_ARM_REG_SP, ARM9_RAM + 0x3F0000)
    ram.reg_write(UC_ARM_REG_LR, ARM9_RAM)
    ram.emu_start(POOLS_INIT, POOLS_INIT_END)

    def u32s(addr, n):
        return struct.unpack("<%di" % n, ram.mem_read(addr, 4 * n))

    out = []
    for record, name, desc in CHAMP_EVENTS:
        count, prize, _, battles = u32s(record, 4)
        pools = []
        for k in range(count):
            size = ram.mem_read(battles + 8 * k, 1)[0]
            pool = u32s(battles + 8 * k + 4, 1)[0]
            teams = []
            for j in range(size):
                *slots, team = u32s(pool + 0x14 * j, 4)
                members = [u32s(MEMBERS + s * MEMBER_RECORD, 1)[0] for s in slots]
                teams.append({"team": team, "members": [m for m in members if m != EMPTY_SLOT]})
            pools.append(teams)
        out.append({"name": name, "desc": desc, "prize": prize, "battles": pools})
    return out


def tamer_ranks(arm9):
    """[(total capacity, highest level reachable)] per Tamer Rank."""
    rows = []
    for rank in range(10):
        capacity, *_, below = struct.unpack_from("<5i", arm9, RANKS - ARM9_RAM + rank * 0x24)
        rows.append((capacity, below))
    return rows


def sprite_png(fs_dir, sprite, cache):
    """First frame of the idle animation, cropped, scaled x2 (nearest), as PNG bytes."""
    if sprite in cache:
        return cache[sprite]
    base = os.path.join(fs_dir, "digimon", sprite + "_main")
    chars, bpp, tiled, palette, cells, unit = sprite_tool.load(base)
    cell = sprite_tool.read_anims(base + ".nanr")[0][0][0]
    img = sprite_tool.render_cell(cells[cell], unit, chars, bpp, tiled, palette)
    img = img.crop(img.getbbox())
    img = img.resize((img.width * 2, img.height * 2), Image.NEAREST)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    cache[sprite] = (buf.getvalue(), img.size)
    return cache[sprite]


def clean(text):
    return re.sub(r"\{esc:[0-9A-F]{4}\}", "", text).replace("\\n", " ").replace("\n", " ").strip()


def competition(desc):
    """Split a title description into (description, format, conditions)."""
    highlights = [clean(h) for h in re.findall(r"\{esc:000D\}(.*?)\{esc:0002\}", desc)]
    fmt, conditions = "", []
    for h in highlights:
        # One highlight can hold both: "5 or greater. 3 vs. 3"
        match = re.search(r"\d\s*vs\.\s*\d", h)
        if match and not fmt:
            fmt, h = match.group(), h[:match.start()]
        if h.strip(" ."):
            conditions.append(h.strip(" ."))
    head = clean(desc.split("{esc:000D}")[0])
    for prefix in ("Degen. to DigiEgg", "Capacity"):   # "Degen. to DigiEgg <3 or greater>"
        if head.endswith(prefix) and conditions:
            head = head[: -len(prefix)].strip()
            conditions[0] = prefix + " " + conditions[0]
    return head, re.sub(r"\s+", " ", fmt.replace("vs.", " vs. ")).strip(), " + ".join(conditions)


def table(data, widths, header_rows=1, align_center=()):
    t = Table(data, colWidths=widths, repeatRows=header_rows)
    style = [
        ("BACKGROUND", (0, 0), (-1, header_rows - 1), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, header_rows - 1), GOLD),
        ("FONTNAME", (0, 0), (-1, header_rows - 1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, header_rows), (-1, -1), [colors.white, LIGHT]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]
    for col in align_center:
        style.append(("ALIGN", (col, 0), (col, -1), "CENTER"))
    t.setStyle(TableStyle(style))
    return t


def build(rom_path, fs_dir, out_path):
    db = texts("db_txt_list_txt.json")
    txt = texts("txt_list_txt.json")
    arm9 = read_arm9(rom_path)
    mons = digimon(arm9, db)

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], textColor=NAVY, fontSize=18, spaceAfter=6)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], textColor=NAVY, fontSize=13, spaceBefore=8, spaceAfter=4)
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=9, leading=12)
    cell = ParagraphStyle("cell", parent=body, fontSize=7.5, leading=9.5)
    tiny = ParagraphStyle("tiny", parent=body, fontSize=6.5, leading=7.5, alignment=1)

    story = [
        Paragraph("Digimon World Championship — Game Data Guide", h1),
        Paragraph(
            "Everything is read straight from the ROM (Digimon table, stat curves, evolution, title and team "
            "tables of the game code, and the game texts). Names and terms are those of the US version.", body),
        Spacer(1, 4),
        Paragraph(
            "<b>Base stats</b>: the values a Digimon gets when it is born or digivolves into that species. "
            "The game adds a small random bonus: each column gives the minimum, and HP also shows the "
            "highest possible value in brackets. HP and TP are the starting maximums. "
            "<b>ID</b> = species number in the game (hexadecimal). Some names appear twice "
            "(Garurumon, MetalGreymon, WereGarurumon, MetalGarurumon, Coredramon): they are two distinct "
            "variants, with a different attribute or colour.", body),
        Spacer(1, 6),
        Paragraph(f"<b>{len(mons)} Digimon</b> · digivolution trees and requirements · "
                  f"<b>{TITLE_COUNT} Title Matches</b> by date with opponent teams · Championship rules and opponents, other "
                  "battle modes", body),
    ]

    # --- Digimon -------------------------------------------------------------------------
    cache = {}
    story += [PageBreak(), Paragraph("1. Digimon List", h1)]
    for level in range(1, 7):
        group = [m for m in mons if m["level"] == level]
        story.append(Paragraph(f"{LEVELS[level]} — {len(group)} Digimon", h2))
        rows = [["ID", "Sprite", "Name", "Attribute", "Type", "HP", "TP", "ATK", "DEF", "WIS", "SPD"]]
        for m in group:
            png, (w, h) = sprite_png(fs_dir, m["sprite"], cache)
            scale = min(1.0, 30 / max(w, h))   # points; the biggest Megas are shrunk to fit the row
            img = RLImage(io.BytesIO(png), width=w * scale, height=h * scale)
            hp_low, hp_high = m["stats"][0]
            rows.append([
                f"{m['species']:02X}", img, Paragraph(f"<b>{m['name']}</b>", cell), m["attribute"],
                Paragraph(m["types"], cell), f"{hp_low} ({hp_high})",
                *[str(low) for low, _ in m["stats"][1:]],
            ])
        story.append(table(rows, [9 * mm, 14 * mm, 34 * mm, 16 * mm, 24 * mm, 22 * mm] + [12 * mm] * 5,
                           align_center=(0, 1, 5, 6, 7, 8, 9, 10)))

    # --- Digivolution trees ---------------------------------------------------------------------
    evo = evolutions(arm9)
    by_species = {m["species"]: m for m in mons}
    sources = {}
    for species, targets in evo.items():
        for target, _, _ in targets:
            sources.setdefault(target, []).append(species)

    story += [PageBreak(), Paragraph("2. Digivolution Trees", h1)]
    story.append(Paragraph(
        "Read from the ROM's evolution table and from the game function that checks it (overlay 18). "
        "For each species, its digivolutions are listed <b>in the order the game tests them</b>: the first "
        "one whose requirements are all met wins. Megas do not digivolve any further.", body))
    story.append(Spacer(1, 3))
    rows = [["Requirement", "Meaning"]]
    for name, meaning in [
        ("Vaccine / Data / Virus min. N", "Attribute points of the Digimon, earned from the cage it trains in."),
        ("Dragon, Beast, Aquatic, Bird, I.Plant, Holy, Dark, Machine min. N",
         "Species points, also given by the cages."),
        ("Battles min. N", "Number of battles this Digimon has fought."),
        ("Win rate min. N %", "Percentage of battles won."),
        ("DigiEgg min. Nx", "Number of times the line degenerated to a DigiEgg (Degen. to DigiEgg)."),
        ("Injuries", "Number of injuries taken in battle (the counter stops at 7)."),
        ("End of life", "Fallback digivolution: tested only when the life span runs out. If none fits, "
                        "the Digimon turns back into a DigiEgg. Digivolving in time extends its life."),
    ]:
        rows.append([Paragraph(f"<b>{name}</b>", cell), Paragraph(meaning, cell)])
    story.append(table(rows, [62 * mm, 120 * mm]))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Two limits apply to every digivolution: the <b>Tamer Rank</b> (license) caps the highest level "
        "reachable, and the total <b>capacity</b> (G) of your Digimon must stay within your rank's limit "
        "once the digivolution is done (a digivolved Digimon takes more room).", body))
    story.append(Spacer(1, 3))
    rows = [["Tamer Rank"] + [str(r) for r in range(10)],
            ["Highest level"] + [SHORT_LEVELS[below] for _, below in tamer_ranks(arm9)],
            ["Total capacity (G)"] + [str(capacity) for capacity, _ in tamer_ranks(arm9)]]
    story.append(table(rows, [30 * mm] + [15.2 * mm] * 10, align_center=range(1, 11)))

    for level in range(1, 6):
        story.append(Spacer(1, 6))
        story.append(Paragraph(f"From {LEVELS[level]}", h2))
        for m in [m for m in mons if m["level"] == level and evo.get(m["species"])]:
            png, (w, h) = sprite_png(fs_dir, m["sprite"], cache)
            scale = min(1.0, 26 / max(w, h))
            came = ", ".join(sorted({by_species[s]["name"] for s in sources.get(m["species"], [])}))
            head = (f"<b>{m['name']}</b> — {SHORT_LEVELS[m['level']]} · {m['attribute']} · {m['types']}"
                    + (f"<br/><font color='#555555'>Comes from: {came}</font>" if came else ""))
            rows = [[RLImage(io.BytesIO(png), width=w * scale, height=h * scale), Paragraph(head, cell), "", ""]]
            for k, (target, default, conds) in enumerate(evo[m["species"]]):
                t = by_species[target]
                png, (w, h) = sprite_png(fs_dir, t["sprite"], cache)
                scale = min(1.0, 22 / max(w, h))
                text = ", ".join(conds) if conds else ""
                if default:
                    text = "<font color='#b07800'><b>End of life</b></font>" + (f" — {text}" if text else " (default)")
                elif not conds:
                    text = "-"
                rows.append([f"{k + 1}", RLImage(io.BytesIO(png), width=w * scale, height=h * scale),
                             Paragraph(f"<b>{t['name']}</b><br/>{SHORT_LEVELS[t['level']]} · {t['attribute']} · "
                                       f"{t['capacity']} G", cell),
                             Paragraph(text, cell)])
            t = Table(rows, colWidths=[10 * mm, 14 * mm, 46 * mm, 112 * mm])
            t.setStyle(TableStyle([
                ("SPAN", (1, 0), (-1, 0)),
                ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
                ("LINEABOVE", (0, 0), (-1, 0), 0.8, NAVY),
                ("LINEBELOW", (0, 1), (-1, -1), 0.25, GRID),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (1, -1), "CENTER"),
                ("TOPPADDING", (0, 0), (-1, -1), 1.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
            ]))
            story += [KeepTogether(t), Spacer(1, 4)]

    # --- Competitions --------------------------------------------------------------------------
    story += [PageBreak(), Paragraph("3. Cups and Competitions", h1)]

    story.append(Paragraph("Battle modes", h2))
    rows = [["Mode", "Description"]]
    for k in range(6):
        rows.append([Paragraph(f"<b>{clean(txt[661 + k])}</b>", cell), Paragraph(clean(txt[667 + k]), cell)])
    story.append(table(rows, [35 * mm, 145 * mm]))

    titles = title_matches(arm9)

    def team_cell(t):
        sprites, names = [], []
        for species in t["members"]:
            m = by_species[species]
            png, (w, h) = sprite_png(fs_dir, m["sprite"], cache)
            scale = min(1.0, 28 / max(w, h))
            sprites.append(RLImage(io.BytesIO(png), width=w * scale, height=h * scale))
            names.append(Paragraph(f"<b>{m['name']}</b><br/>{SHORT_LEVELS[m['level']]}", tiny))
        inner = Table([[Paragraph(f"<b>{clean(txt[t['team']])}</b>", cell), "", ""],
                       sprites + [""] * (3 - len(sprites)), names + [""] * (3 - len(names))],
                      colWidths=[25 * mm] * 3)
        inner.setStyle(TableStyle([
            ("SPAN", (0, 0), (-1, 0)),
            ("ALIGN", (0, 1), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 1), ("RIGHTPADDING", (0, 0), (-1, -1), 1),
            ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        return inner

    def title_row(t, day):
        desc = txt[t["desc"]]
        head, fmt, cond = competition(desc)
        big7 = " <font color='#b07800'><b>Big 7</b></font>" if "Big 7" in desc else ""
        rules = f"<b>{fmt or '-'}</b>" + (f"<br/>{cond}" if cond else "")
        rules += f"<br/><font color='#555555'>From Tamer Rank {2 * t['tier']}</font>"
        return [day, Paragraph(f"<b>{clean(txt[t['name']])}</b>{big7}<br/>"
                               f"<font color='#555555'>{head}</font>", cell),
                Paragraph(rules, cell), team_cell(t)]

    # --- Championship: Preliminaries and Championship, each battle against a random team of a pool ---
    rank = lambda r: f"{r} ({clean(txt[1443 + r])})"   # noqa: E731
    story.append(Paragraph("Championship tournament (Autumn, Day 5)", h2))
    story.append(Paragraph(
        "The tournament is the game's main goal. It is fought on <b>Day 5 of Autumn</b>, as a series of "
        "3 vs. 3 battles in a row: one loss ends the run. Each battle is against a team picked <b>at random</b> "
        "among the teams listed for that battle.", body))
    story.append(Spacer(1, 2))
    rules = [
        ["Step", "When / how"],
        ["Open the Preliminaries", f"Reach Tamer Rank {rank(4)} (the game says \"You qualified for the "
                                   "Preliminaries!\")."],
        ["Preliminaries", "Held every year except Championship years. Win the 3 battles to qualify "
                          "(\"You qualified for the Championship!\")."],
        ["Championship", "Held once every 4 years (in-game years 4, 8, 12...). Only for Tamers who won the "
                         "Preliminaries at least once in the 3 years before. 5 battles."],
        ["Win the Championship", f"Tamer Rank goes up to {rank(8)} if lower. {rank(9)}: Champ rank and "
                                 f"all {CALENDAR_TITLES} title matches won."],
    ]
    story.append(table([rules[0]] + [[Paragraph(f"<b>{a}</b>", cell), Paragraph(b, cell)] for a, b in rules[1:]],
                       [40 * mm, 142 * mm]))
    for event in championship(arm9):
        count = len(event["battles"])
        story.append(Paragraph(f"{clean(txt[event['name']])} — {count} battles, prize "
                               f"{event['prize']:,} bits", h2))
        story.append(Paragraph(clean(re.sub(r"\{esc:000D\}.*", "", txt[event["desc"]])), body))
        story.append(Spacer(1, 2))
        rows = [["Battle", "Possible opponents (one is picked at random)", ""]]
        spans = []
        for k, pool in enumerate(event["battles"]):
            label = Paragraph(f"<b>{'Final' if k == count - 1 else f'Battle {k + 1}'}</b><br/>"
                              f"<font color='#555555'>{len(pool)} team{'s' if len(pool) > 1 else ''}</font>", cell)
            first = len(rows)
            for j in range(0, len(pool), 2):
                pair = [team_cell(t) for t in pool[j:j + 2]]
                rows.append([label if j == 0 else ""] + pair + [""] * (2 - len(pair)))
            spans.append(("SPAN", (0, first), (0, len(rows) - 1)))
        t = table(rows, [22 * mm, 80 * mm, 80 * mm], align_center=(0,))
        t.setStyle(TableStyle([("SPAN", (1, 0), (2, 0))] + spans))
        story.append(t)

    story += [PageBreak(), Paragraph("Title Match calendar", h2)]
    story.append(Paragraph(
        "Title matches come back every year on the same day. A year has four seasons of 8 days each. "
        "Within a season, titles are listed by day as in the in-game schedule. <b>From Tamer Rank</b> = the "
        "rank at which the title starts to show up on the schedule. <b>Big 7</b> = one of the seven greatest "
        "titles. Requirements (level, species, attribute, field...) are those shown by the game.", body))
    story.append(Spacer(1, 4))
    header = ["Day", "Title", "Format / rules", "Opponent team"]
    widths = [11 * mm, 58 * mm, 36 * mm, 77 * mm]
    rows = [header, title_row(titles[CALENDAR_TITLES], "-")]
    story.append(Paragraph("Tutorial (not on the calendar)", h2))
    story.append(table(rows, widths, align_center=(0,)))
    for season, name in enumerate(SEASONS):
        story.append(Paragraph(name, h2))
        events = [((t["day"], t["id"]), title_row(t, str(t["day"] + 1)))
                  for t in titles[:CALENDAR_TITLES] if t["season"] == season]
        if name == "Autumn":   # "held on the 5th day of Autumn" (game mail), once every 4 years
            events.append(((4, -1), ["5", Paragraph("<b>Preliminaries / Championship</b><br/><font color="
                                                    "'#555555'>See the Championship table above.</font>", cell),
                                     Paragraph("<b>3 vs. 3</b>", cell), ""]))
        story.append(table([header] + [row for _, row in sorted(events, key=lambda e: e[0])], widths,
                           align_center=(0,)))

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(colors.grey)
        canvas.drawString(15 * mm, 8 * mm, "Digimon World Championship — data extracted from the ROM (personal use)")
        canvas.drawRightString(195 * mm, 8 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(out_path, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm,
                            title="Digimon World Championship — Game Data Guide")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return len(mons)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    n = build(*sys.argv[1:])
    print("%d Digimon -> %s" % (n, sys.argv[3]))
