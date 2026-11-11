// What an admin can see of a player's save (pages /admin/players and /admin/player): tamer, bits,
// rank, play time, in-game date, medals (the cups won), Digipedia, consumables, Digimon and placed
// cages. Also the game's species, item and mail tables, for the gift form.
// docs/mail_and_save_analysis.md explains every field.
//
// The decoded save (save-check.js decodeSave) starts with the player block (0x000..0x1E8), packed
// by ARM9 FUN_0206b854 from the runtime player struct and unpacked by FUN_020720e4. The bit
// positions below were found by running that packer one runtime field at a time.
import fs from "node:fs";
import path from "node:path";
import { readDigimon, readTables } from "./save-check.js";

const ARM9_RAM = 0x02000000;
// Bit fields of the player block: [word offset, first bit, width].
const FIELDS = {
  bits: [0xcc, 0, 24],        // player+0x4D4
  rank: [0xd4, 16, 4],        // player+0xAF4, txt_list 1443 + rank
  minutes: [0xd4, 0, 16],     // player+0xAF6, play time
  food: [0xc4, 0, 7],         // player+0x2C..0x32: the four consumables
  protein: [0xc4, 8, 7],
  medicine: [0xc4, 16, 7],
  bandage: [0xc4, 24, 7],
};
const RANK_TEXT = 1443, RANKS = 10, CUP_TEXT = 675, CUPS = 61;
// The 61 competitions (txt_list 675..735). Each has two runtime words: player+0xC8 + 8 * cup
// ("new" marker, set for the two first cups of a new game) and player+0xCC + 8 * cup (won: ov008
// sets it when the cup is won and counts them for the rank-ups). Absolute bit of the won flag;
// the "new" marker is the next bit.
const CUP_BITS = [...Array.from({ length: 15 }, (_, i) => 2676 + 32 * i),
  ...Array.from({ length: CUPS - 15 }, (_, i) => 3136 + 2 * i)];
// Absolute bit of each of the 216 Digipedia flags (runtime player+0x4FA + i).
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const DEX_BITS = [1735, 1743, 1751, 1759, ...range(1788, 1791), ...range(1820, 1823), ...range(1852, 1855),
  ...range(1884, 1887), ...range(1916, 1919), ...range(1948, 1951), ...range(1958, 1967), ...range(3484, 3661)];
// Calendar (saved from G+0xCxx): two words near the end of the save.
const CLOCK_A = 0xd7c, CLOCK_B = 0xd80;
const SEASONS = ["Spring", "Summer", "Autumn", "Winter"];
const LEVELS = ["", "Baby I", "Baby II", "Rookie", "Champion", "Ultimate", "Mega"];
const SPECIES_FIRST = 8;
const SPECIES_TABLE = 0x020c1d98, SPECIES_RECORD = 0x84, SPECIES_COUNT = 216;   // the last 4 records are battle-only copies
const ATTRIBUTE_TEXT = 1154, TYPE_TEXT = 1160;
// The order of the Digimon's stats in save-check.js (without the current HP and TP) and of its AP.
const STAT_LABELS = ["HP", "TP", "Attack", "Defense", "Wisdom", "Speed"];
const AP_LABELS = ["Heat", "Cold", "Thunder", "Light", "Darkness"];
// Cages: 16 cage kinds of the save at 0xBEC with their place on the farm's hex strip at 0xBFC. Each
// kind has a record of 0x28 bytes: +0x00 shape, +0x20 name text, +0x24 description text. A shape is
// a mask of the strip's cells, shifted by the place (ARM9 0x0206A7BC). Kind 36 fills the free space.
const CAGE_KINDS = 0xbec, CAGE_PLACES = 0xbfc, CAGE_SLOTS = 16;
const CAGE_TABLE = 0x020c92c0, CAGE_RECORD = 0x28, CAGE_COUNT = 36, CAGE_FREE = 36, CAGE_SHAPES = 0x0209ff54;

// Mail tables in ARM9 (catalogue of the game's 201 mails, and the 86 gift definitions).
const MAILS = 0x020f1b94, MAIL_COUNT = 201, MAIL_RECORD = 24;
const GIFTS = 0x020f2e6c, GIFT_COUNT = 86, GIFT_RECORD = 0x1c;
const ITEMS = 0x020e1694, ITEM_COUNT = 118, ITEM_RECORD = 56;
export const SENDERS = ["Digital Arena", "President", "President", "Veteran Tamer", "Shopkeeper", "David",
  "Kate", "Geek Tamer", "Battle King", "Rich Girl", "Digi-Collector", "Mother", "Information"];
const GIFT_KINDS = ["sale", "challenge", "Digimon", "item", "bits", "food"];
// An item's menu category: word 5 of the record before its name (fields start in the previous record).
const ITEM_CATEGORIES = ["Care", "Hunting", "Tools", "Cages"];

const loadText = (dir, name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")).entries.map((e) => e.text);
  } catch { return []; }
};
// Game texts without their control codes.
const clean = (s) => (s ?? "").replace(/\{esc:[0-9A-F]+\}/gi, "").replace(/\\n/g, " ").trim();

// Names and tables the pages need, from the ROM and the text dumps (text/*.json).
export function loadGameInfo(rom, textDir) {
  const list = loadText(textDir, "txt_list_txt"), db = loadText(textDir, "db_txt_list_txt");
  const mailText = loadText(textDir, "mail_text_txt");
  const arm9 = rom ? rom.readUInt32LE(0x20) : 0;
  const i32 = (addr) => rom.readInt32LE(arm9 + addr - ARM9_RAM);
  const u8 = (addr) => rom[arm9 + addr - ARM9_RAM];
  const speciesName = (s) => (s === 0 ? "DigiEgg" : clean(db[s - SPECIES_FIRST]) || `#${s}`);
  const items = [], mails = [], gifts = [], species = [], cages = new Map();
  if (rom) {
    const tables = readTables(rom);
    for (let i = 0; i < SPECIES_COUNT; i++) {
      const o = SPECIES_TABLE + i * SPECIES_RECORD, id = SPECIES_FIRST + i, { level, ranks } = tables.species.get(id);
      const mask = i32(o + 0x18);
      species.push({ id, name: speciesName(id), level: LEVELS[level] ?? "",
        attribute: clean(db[ATTRIBUTE_TEXT + i32(o + 0x10)]),
        types: Array.from({ length: 8 }, (_, k) => k).filter((k) => mask >> k & 1).map((k) => clean(db[TYPE_TEXT + k])),
        base: ranks.map((rank, col) => tables.curve(rank, col)) });
    }
    const itemByName = new Map();
    for (let i = 0; i < ITEM_COUNT; i++) {
      const o = ITEMS + i * ITEM_RECORD;
      itemByName.set(i32(o), i);
      items.push({ id: i, name: clean(list[i32(o)]) || `item ${i}`, price: i32(o + 8),
        category: ITEM_CATEGORIES[i32(o - ITEM_RECORD + 20)] ?? "Other" });
    }
    for (let kind = 0; kind < CAGE_COUNT; kind++) {
      const o = CAGE_TABLE + kind * CAGE_RECORD, text = list[i32(o + 0x24)] ?? "";
      const limit = /Occupancy Limit: (?:\{esc:[0-9A-F]+\})?(\d+)/i.exec(text);
      cages.set(kind, { name: clean(list[i32(o + 0x20)]), item: itemByName.get(i32(o + 0x20)) ?? null,
        shape: u8(CAGE_SHAPES + u8(o)), limit: limit ? Number(limit[1]) : null,
        effect: clean(text.replace(/Occupancy Limit:.*$/is, "")) });
    }
    for (let i = 0; i < GIFT_COUNT; i++) {
      const w = Array.from({ length: 7 }, (_, k) => i32(GIFTS + i * GIFT_RECORD + k * 4));
      gifts.push(w);
    }
    for (let i = 0; i < MAIL_COUNT; i++) {
      const [sender, body, , timer, gift] = Array.from({ length: 5 }, (_, k) => i32(MAILS + i * MAIL_RECORD + k * 4));
      mails.push({ id: i, sender: SENDERS[sender] ?? `#${sender}`, text: clean(mailText[body]), timer,
        gift: gift >= 0 ? describeGift(gifts[gift], { speciesName, items }) : null,
        // Gifts an admin may send: Digimon, item, bits, food (not sell offers or battle challenges).
        giftable: gift >= 0 && gifts[gift][0] >= 2 });
    }
  }
  return { list, speciesName, species, items, mails, cages, rankName: (r) => clean(list[RANK_TEXT + r]) || `rank ${r}`,
    cupName: (t) => clean(list[CUP_TEXT + t]), statLabels: STAT_LABELS, apLabels: AP_LABELS };
}

function describeGift([type, , , , param, param2], { speciesName, items }) {
  const kind = GIFT_KINDS[type] ?? `type ${type}`;
  if (type === 2) return `${kind}: ${speciesName(param)}`;
  if (type === 3) return `${kind}: ${items[param]?.name ?? param} x${param2}`;
  if (type === 4) return `${kind}: ${param}`;
  if (type === 5) return `${kind}: ${param}`;
  return kind;
}

// The save as an admin reads it. raw: decoded save; tables: save-check.js readTables (or null).
export function readProfile(raw, info, tables) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const field = ([word, bit, width]) => (view.getUint32(word, true) >>> bit) & (2 ** width - 1);
  const bitAt = (b, width = 1) => (view.getUint32((b >> 5) * 4, true) >>> (b & 31)) & (2 ** width - 1);
  const v = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, field(f)]));
  const name = String.fromCharCode(...Array.from({ length: 8 }, (_, k) => view.getUint16(k * 2, true)).filter((c) => c));
  const a = view.getUint32(CLOCK_A, true), b = view.getUint32(CLOCK_B, true);
  const medals = Array.from({ length: CUPS }, (_, t) => ({ id: t, name: info.cupName(t), won: bitAt(CUP_BITS[t]) === 1 }));
  const cups = medals.filter((m) => m.won);
  const dex = DEX_BITS.reduce((n, bit) => n + bitAt(bit), 0);
  const digimon = readDigimon(raw).map((d) => {
    const about = info.species.find((s) => s.id === d.species);
    return {
      slot: d.slot, speciesId: d.species, cage: d.cage,
      name: String.fromCharCode(...d.name.filter((c) => c)),
      species: info.speciesName(d.species),
      level: d.species ? LEVELS[tables?.species.get(d.species)?.level] ?? "" : "Egg",
      attribute: about?.attribute ?? "", types: about?.types ?? [],
      hp: d.stats[0], tp: d.stats[1],
      stats: [d.stats[2], d.stats[3], ...d.stats.slice(4)],
      ap: d.ap,
    };
  });
  const cages = [];
  for (let i = 0; i < CAGE_SLOTS; i++) {
    const kind = raw[CAGE_KINDS + i], cage = info.cages.get(kind);
    if (!cage || kind === CAGE_FREE) continue;
    const place = raw[CAGE_PLACES + i];
    cages.push({ index: i, kind, name: cage.name, item: cage.item, limit: cage.limit, effect: cage.effect, place,
      cells: Array.from({ length: 8 }, (_, bit) => bit).filter((bit) => cage.shape >> bit & 1).map((bit) => place + bit),
      digimon: digimon.filter((d) => d.cage === i).map((d) => d.slot) });
  }
  return {
    tamer: name, bits: v.bits, rank: info.rankName(v.rank), rankIndex: v.rank,
    ranks: Array.from({ length: RANKS }, (_, r) => info.rankName(r)),
    playTime: `${Math.floor(v.minutes / 60)} h ${String(v.minutes % 60).padStart(2, "0")}`,
    date: {
      year: ((a >>> 20) & 0x7f) + 1, season: SEASONS[(b >>> 9) & 3], day: ((b >>> 6) & 7) + 1,
      time: `${String(a >>> 27).padStart(2, "0")}:${String(b & 63).padStart(2, "0")}`,
    },
    // id: the item's index, for its icon.
    consumables: [{ id: 0, name: "Food", count: v.food }, { id: 1, name: "Protein", count: v.protein },
      { id: 3, name: "Medicine", count: v.medicine }, { id: 2, name: "Bandage", count: v.bandage }],
    cups, medals, cupCount: CUPS, dex, dexCount: DEX_BITS.length, digimon, cages,
  };
}
