"""The developer's team: the Championship final against Apollomon, Dianamon and Machinedramon with
stats far above the game's own.

  python tools/make_dev_team.py <rom.nds> [--name "Dev Team"] [--hp 9999] [--tp 999] [--atk 999]
                                [--def 999] [--wis 999] [--spd 999]

The final of the Championship has a pool of one team, record 98 ("Death & Laws": Apollomon,
SkullGreymon, GigaSeadramon), copied at boot into the pool (make_guide.py). Its members are records
294-296 of the member table (0x020E5564, 0x44 bytes each), used by no other team. A member is
{+0x00 species, +0x08 nickname (UTF-16), +0x10 HP rank (unused), +0x14..+0x24 TP, Atk, Def, Wis,
Spd ranks, +0x28..+0x38 five more ranks (column 6 of the stat curves), +0x3D, +0x3E}. A rank is a
row (0-26) of the stat curves at 0x020CA60C; the HP comes from the species' own rank.

This writes patches/dev_team.json:
  - the opponent builder (ARM9 FUN_020620e8, 0x02062278 to its epilogue): its unrolled stat copy
    is rewritten as a loop that gives every game opponent exactly the same Digimon as before, plus
    one rule: a value above 26 (the game's ranks stop at 23) is the stat itself, and an HP rank
    above 26 is the HP. The rank then kept is 26;
  - members 294-296: copies of the game's own Apollomon "Judge" (294), Dianamon "Diana" (171) and
    Machinedramon "Mugen" (183), with the given HP and stats;
  - team 98's name: text 1569 of txt_list (DEV_TEAM_TEXT, set in text/txt_list_txt.json here;
    rebuild mod/ui/txt/txt_list_txt.dat with txt_tool.py, see README).
Needs keystone-engine.
"""
import argparse
import json
import os
import struct
import sys

from keystone import KS_ARCH_ARM, KS_MODE_ARM, Ks

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nds_tool import code_region  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "patches", "dev_team.json")
TEXTS = os.path.join(ROOT, "text", "txt_list_txt.json")
STATS_CODE, EPILOGUE, CURVES_LITERAL = 0x02062278, 0x020623DC, 0x020623E8
MEMBERS, MEMBER = 0x020E5564, 0x44
TEAMS, TEAM = 0x020EEE64, 0x14
FINAL_TEAM, FINAL_MEMBERS = 98, (294, 295, 296)
DEV_TEAM_TEXT = 1569   # first free entry of txt_list
MAX_RANK = 26
# (member record copied, species): Apollomon "Judge", Dianamon "Diana", Machinedramon "Mugen"
SOURCES = [(294, 0xDC), (171, 0xDD), (183, 0xD2)]

# r5 = member record, r6 = the Digimon built, [sp + 0x30] = the species' HP rank.
CODE = (f"ldr r0, [pc, #{CURVES_LITERAL - STATS_CODE - 8:#x}]\n"   # stat curves, column 0 (HP)
        "ldr r2, [r5, #0x10]\ncmp r2, #26\nbgt hp\n"
        "ldrh r2, [sp, #0x30]\nadd r2, r0, r2, lsl #4\nldrsh r2, [r2]\n"
        "hp: str r2, [r6, #0x58]\nstr r2, [r6, #0x60]\n"
        "mov r1, #0\nadd r3, r6, #0xb0\nmov ip, #22\n"                 # 11 pairs of words cleared
        "zero: str r1, [r3], #4\nsubs ip, ip, #1\nbne zero\n"
        "mov ip, #0\n"                                                 # k: TP, Atk, Def, Wis, Spd, 5 more
        "stat: add r3, r5, ip, lsl #2\nldr r2, [r3, #0x14]\nadd r3, r6, ip, lsl #2\n"
        "add r4, ip, #1\ncmp r4, #6\nmovgt r4, #6\n"                   # curve column: k + 1, at most 6
        "cmp r2, #26\nmovgt r7, r2\nmovgt r2, #26\n"
        "addle r7, r0, r2, lsl #4\naddle r7, r7, r4, lsl #1\nldrhle r7, [r7]\n"
        "cmp ip, #0\nstrne r2, [r3, #0x88]\nstreq r7, [r6, #0x5c]\nstr r7, [r3, #0x64]\n"
        "add ip, ip, #1\ncmp ip, #10\nblt stat\n"
        "ldrb r0, [r5, #0x3d]\nstr r0, [r6, #0x134]\nldrb r0, [r5, #0x3e]\nstr r0, [r6, #0x138]\n"
        f"b {EPILOGUE:#x}\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("rom")
    ap.add_argument("--name", default="Dev Team")
    for stat, default in (("hp", 9999), ("tp", 999), ("atk", 999), ("def", 999), ("wis", 999), ("spd", 999)):
        ap.add_argument(f"--{stat}", type=int, default=default)
    args = ap.parse_args()
    stats = [args.tp, args.atk, getattr(args, "def"), args.wis, args.spd]
    assert args.hp > MAX_RANK and min(stats) > MAX_RANK, "stats must be above 26 (lower values are ranks)"

    rom = open(args.rom, "rb").read()
    start, ram, _ = code_region(rom, None)
    arm9 = lambda addr, n: rom[start + addr - ram:start + addr - ram + n]   # noqa: E731

    code = bytes(Ks(KS_ARCH_ARM, KS_MODE_ARM).asm(CODE, STATS_CODE)[0])
    assert STATS_CODE + len(code) <= EPILOGUE, "the new stat code overflows"
    assert struct.unpack("<I", arm9(CURVES_LITERAL, 4))[0] == 0x020CA60C, "wrong ROM (curve literal)"

    patches = [{"address": f"{STATS_CODE:#010x}", "original": arm9(STATS_CODE, len(code)).hex(),
                "replacement": code.hex(),
                "comment": "opponent builder FUN_020620e8: stat copy as a loop; a value above 26 is the stat itself"}]
    members = b""
    for source, species in SOURCES:
        rec = bytearray(arm9(MEMBERS + source * MEMBER, MEMBER))
        assert rec[0] == species, f"member {source} is not species {species:#x}"
        struct.pack_into("<I", rec, 0x04, 0)
        struct.pack_into("<I", rec, 0x0C, 0)
        struct.pack_into("<6I", rec, 0x10, args.hp, *stats)
        members += rec
    first = MEMBERS + FINAL_MEMBERS[0] * MEMBER
    patches.append({"address": f"{first:#010x}", "original": arm9(first, len(members)).hex(),
                    "replacement": members.hex(),
                    "comment": f"members {FINAL_MEMBERS}: Apollomon, Dianamon, Machinedramon, HP {args.hp}, "
                               f"TP/Atk/Def/Wis/Spd {'/'.join(map(str, stats))}"})
    name_field = TEAMS + FINAL_TEAM * TEAM + 0x0C
    patches.append({"address": f"{name_field:#010x}", "original": arm9(name_field, 4).hex(),
                    "replacement": struct.pack("<I", DEV_TEAM_TEXT).hex(),
                    "comment": f"team {FINAL_TEAM} (Championship final) name: txt_list {DEV_TEAM_TEXT}"})

    doc = {"description": " ".join(__doc__.split("\n\n")[0].split()) + " " + " ".join(__doc__.split("\n\n")[2].split()),
           "patches": patches}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    texts = json.load(open(TEXTS, encoding="utf-8"))
    entries = texts["entries"]
    assert len(entries) >= DEV_TEAM_TEXT, "txt_list is shorter than expected"
    if len(entries) == DEV_TEAM_TEXT:
        entries.append({"id": DEV_TEAM_TEXT, "text": args.name})
    entries[DEV_TEAM_TEXT]["text"] = args.name
    with open(TEXTS, "w", encoding="utf-8") as f:
        json.dump(texts, f, ensure_ascii=False, indent=1)   # as txt_tool.py writes it (no final newline)
    print(f"{len(patches)} patches -> {os.path.abspath(OUT)}; team name \"{args.name}\" -> txt_list {DEV_TEAM_TEXT}")


if __name__ == "__main__":
    main()
