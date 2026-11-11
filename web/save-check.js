// Anti-cheat, step 2 (docs/anti_cheat_strategy.md, R3 and R4): reads the Digimon of a save and
// checks that a new save can follow the previous one, and that a Digimon sent in an online match
// is one of the player's saved Digimon.
//
// Save format: tools/save_tool.py (header, NBLC block, LZ10 + Burrows-Wheeler). The decoded data
// (3548 bytes) holds 16 Digimon slots of 0x78 bytes at 0x1E8, bit-packed; ARM9 FUN_0206b1d4
// unpacks one into the game's 0x1D0-byte Digimon struct, and FUN_0209285c packs that struct into
// the 0x6C-byte record sent in Multi Battle (docs/multiplayer_analysis.md §4.2).
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const RAW_SIZE = 0xddc;
const SLOTS = 16, SLOT_BASE = 0x1e8, SLOT_SIZE = 0x78;
const NAME_OFFSET = 0x60, NAME_CHARS = 9;
const EGG = 0;   // species of a DigiEgg that has not hatched yet
// Stats in the order of the Digimon struct (+0x58..+0x77) and of the packet (+0x1C): current HP,
// current TP, max HP, max TP, then four battle stats. CURVE_COLUMN: column of the stat curves.
export const STAT_NAMES = ["HP", "TP", "HP max", "TP max", "Atk", "Def", "Wis", "Spd"];
const CURVE_COLUMN = [0, 1, 0, 1, 2, 3, 4, 5];

// Game tables in ARM9 (tools/make_guide.py documents them).
const ARM9_RAM = 0x02000000;
const TABLE = 0x020c1d98, RECORD = 0x84, SPECIES_FIRST = 8, SPECIES_COUNT = 220;
const CURVES = 0x020ca60c, CURVE_ROWS = 25;
const EVO_TABLE = 0x020e0620, EVO_INIT = 0x02099ac0, EVO_COUNT = 179, EVO_RECORD = 60;

// What a save may gain between two uploads: a base plus a rate per minute of real time (the page
// uploads every 15 s while the save changes). Generous on purpose: a flag only bars ranked play.
const GAIN_BASE = [300, 30, 300, 30, 30, 30, 30, 30];
const GAIN_PER_MINUTE = [100, 10, 100, 10, 10, 10, 10, 10];

// --- .sav decoding ----------------------------------------------------------------

function lz10(src) {
  if (src[0] !== 0x10) throw new Error("not LZ10");
  const size = src[1] | src[2] << 8 | src[3] << 16;
  const out = new Uint8Array(size);
  let i = 4, o = 0;
  while (o < size) {
    const flags = src[i++];
    for (let bit = 0; bit < 8 && o < size; bit++) {
      if (flags & (0x80 >> bit)) {
        const b0 = src[i++], b1 = src[i++];
        const length = (b0 >> 4) + 3, disp = ((b0 & 0xf) << 8 | b1) + 1;
        for (let k = 0; k < length && o < size; k++, o++) out[o] = out[o - disp];
      } else {
        out[o++] = src[i++];
      }
    }
  }
  return out;
}

// Inverse Burrows-Wheeler transform as the game does it (ARM9 FUN_0205364c).
function ibwt(src, index) {
  const counts = new Uint32Array(257);
  for (const b of src) counts[b + 1]++;
  for (let b = 1; b < 257; b++) counts[b] += counts[b - 1];
  const order = new Uint32Array(src.length);   // stable sort of the positions by byte
  for (let k = 0; k < src.length; k++) order[counts[src[k]]++] = k;
  const out = new Uint8Array(src.length);
  let p = order[index];
  for (let k = 0; k < src.length; k++) {
    out[k] = src[p];
    p = order[p];
  }
  return out;
}

// The decoded game data of a .sav, or an Error.
export function decodeSave(sav) {
  const buf = Buffer.from(sav);
  if (buf.length < 0x10 || buf.toString("latin1", 0, 8) !== "DIGICHMP") throw new Error("not a save");
  const start = buf.readUInt16LE(8), inv = buf.readUInt16LE(10);
  // The records form a ring: the current one may come before the header's start, so scan from
  // the start, then again from the first record.
  for (let pos of new Set([start && start === (inv ^ 0xffff) ? start : 0xc, 0xc])) {
    while (pos + 4 < buf.length) {
      const flags = buf.readUInt16LE(pos), length = buf.readUInt16LE(pos + 2);
      if (length & 3 || length !== ((flags & 0xfffc) ^ 0xfffc) || pos + 4 + length > buf.length) {
        pos += 4;
        continue;
      }
      if ((flags & 3) === 1) return decodeBlock(buf.subarray(pos + 4, pos + 4 + length));
      pos += 4 + length;
    }
  }
  throw new Error("no current save record");
}

function decodeBlock(blk) {
  if (blk.toString("latin1", 0, 4) !== "NBLC") throw new Error("not an NBLC block");
  const rawSize = blk.readUInt32LE(4), packedSize = blk.readUInt32LE(8), crc = blk.readUInt32LE(12);
  const body = blk.subarray(0x10, 0x10 + packedSize);
  if (zlib.crc32(body) !== crc) throw new Error("NBLC CRC mismatch");
  if (rawSize !== RAW_SIZE) throw new Error(`unexpected save size ${rawSize}`);
  const size = body.readUInt16LE(0), index = body.readUInt16LE(2);   // one chunk
  let data = body.subarray(4, 4 + size);
  if (size !== rawSize) data = lz10(data);
  return ibwt(data, index);
}

// --- Digimon slots --------------------------------------------------------------

// The saved Digimon, as the fields the game sends in Multi Battle (FUN_0206b1d4 bit layout).
export function readDigimon(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const base = SLOT_BASE + slot * SLOT_SIZE;
    const w = (k) => view.getUint32(base + k * 4, true);
    if (!((w(0x1d) >>> 19) & 1)) continue;   // empty slot
    const name = [];
    for (let k = 0; k < NAME_CHARS; k++) name.push(view.getUint16(base + NAME_OFFSET + k * 2, true));
    out.push({
      slot,
      // The slot's bytes: the game rebuilds the rest of the sent record (+0x40..+0x6B) from them,
      // so a record the referee saw the game send once is known for this hash (online.js).
      record: createHash("sha256").update(raw.subarray(base, base + SLOT_SIZE)).digest("hex"),
      species: w(0) & 0xff,
      form: (w(0xe) & 0x1ffffff) >>> 22,         // struct +0x18
      extra: w(8) >>> 27,                        // struct byte +0x4C
      cage: w(5) >>> 28,                         // struct +0x1A0: index in the save's cage list
      name,
      stats: [w(10) & 0x1fff, (w(0x17) & 0x7ffff) >>> 10, w(0xb) & 0x1fff, w(0x1d) & 0x1ff,
        (w(0x1d) & 0x3ffff) >>> 9, w(8) & 0x1ff, (w(8) & 0x3ffff) >>> 9, (w(8) & 0x7ffffff) >>> 18],
      ap: [w(9) & 0x1ff, (w(9) & 0x3ffff) >>> 9, (w(9) & 0x7ffffff) >>> 18, w(10) >>> 23, w(11) >>> 23],   // struct +0x78..+0x88
    });
  }
  return out;
}

const nameText = (d) => String.fromCharCode(...d.name.filter((c) => c));

// --- game tables -----------------------------------------------------------------

export function readTables(rom) {
  const arm9Offset = rom.readUInt32LE(0x20);
  const u32 = (addr) => rom.readUInt32LE(arm9Offset + addr - ARM9_RAM);
  const u16 = (addr) => rom.readUInt16LE(arm9Offset + addr - ARM9_RAM);
  const u8 = (addr) => rom[arm9Offset + addr - ARM9_RAM];
  const species = new Map();
  for (let i = 0; i < SPECIES_COUNT; i++) {
    const o = TABLE + i * RECORD;
    species.set(SPECIES_FIRST + i, {
      level: u32(o + 0x0c),
      ranks: [u16(o + 0x30), u16(o + 0x32), u16(o + 0x34), u16(o + 0x36), u8(o + 0x38), u8(o + 0x39)],
    });
  }
  const curve = (row, col) => u16(CURVES + Math.min(row, CURVE_ROWS - 1) * 16 + col * 2);
  const evolutions = new Set();   // "from>to"
  for (let k = 0; k < EVO_COUNT; k++) {
    const src = u32(EVO_INIT + k * 8), dst = u32(EVO_INIT + k * 8 + 4);
    const from = SPECIES_FIRST + (dst - EVO_TABLE) / 12;
    const count = u32(src), records = u32(src + 4);
    for (let n = 0; n < count; n++) evolutions.add(`${from}>${u32(records + n * EVO_RECORD)}`);
  }
  return { species, curve, evolutions };
}

// Highest value a stat can have on a Digimon just obtained: its species' curve one rank up (a new
// Digimon gets its rank's value plus at most half the step to the next one).
function freshCap(tables, species, stat) {
  const col = CURVE_COLUMN[stat];
  return tables.curve(tables.species.get(species).ranks[col] + 1, col);
}

// --- R3: is this save a plausible continuation of the previous one? --------------

// prev: Digimon of the previous accepted save (null for the first one). Returns problems (text).
// gifted: Digimon an admin gave with bonus stats that no save has shown yet, { id, species, bonus }
// (web/gifts.js); the ids of those this save's stats needed go in `used`.
export function checkSave(digimon, prev, elapsedMs, tables, gifted = [], used = new Set()) {
  const problems = [];
  const minutes = Math.max(0, elapsedMs) / 60_000;
  for (const d of digimon) {
    const gift = gifted.find((g) => g.species === d.species && !used.has(g.id));
    // Is this stat above what the game allows, once the gift's bonus is counted?
    const above = (s, cap) => {
      if (d.stats[s] <= cap) return false;
      if (!gift || d.stats[s] > cap + gift.bonus[s - 2]) return true;
      used.add(gift.id);
      return false;
    };
    const label = `emplacement ${d.slot} (${nameText(d) || "sans nom"})`;
    if (d.species === EGG) continue;
    if (!tables.species.has(d.species)) {
      problems.push(`${label} : espèce inconnue ${d.species}`);
      continue;
    }
    if (d.stats[0] > d.stats[2] || d.stats[1] > d.stats[3]) problems.push(`${label} : PV/TP au-dessus du maximum`);
    if (!prev) continue;
    // The same Digimon in the previous save: same name (it may have moved or digivolved).
    // An egg that hatched counts as a new Digimon.
    const before = prev.filter((p) => p.species !== EGG && p.name.join() === d.name.join());
    if (!before.length) {
      // A new Digimon (hatched, received): its species' starting stats, plus what training since
      // the previous save can add.
      for (let s = 2; s < 8; s++) {
        const cap = Math.floor(freshCap(tables, d.species, s) + GAIN_BASE[s] + GAIN_PER_MINUTE[s] * minutes);
        if (above(s, cap)) problems.push(`${label} : nouveau Digimon avec ${STAT_NAMES[s]} ${d.stats[s]} > ${cap}`);
      }
      continue;
    }
    const issues = before.map((p) => transition(p, d, minutes, tables, above));
    if (issues.every((list) => list.length)) problems.push(...issues[0].map((text) => `${label} : ${text}`));
  }
  return problems;
}

function transition(p, d, minutes, tables, above) {
  const issues = [];
  const evolved = p.species !== d.species;
  // A digivolution from the game's table, or back to a baby (degeneration to a DigiEgg).
  if (evolved && !tables.evolutions.has(`${p.species}>${d.species}`) && tables.species.get(d.species).level > 1) {
    issues.push(`passage impossible de l'espèce ${p.species} à ${d.species}`);
  }
  for (let s = 2; s < 8; s++) {
    let allowed = p.stats[s] + GAIN_BASE[s] + GAIN_PER_MINUTE[s] * minutes;
    if (evolved) allowed += freshCap(tables, d.species, s);
    if (above(s, allowed)) issues.push(`${STAT_NAMES[s]} ${p.stats[s]} → ${d.stats[s]} trop vite`);
  }
  return issues;
}

// --- R4: is a relayed Digimon one of the saved ones? -------------------------------

const PACKET_RECORD = 0x6c;

// packet: the 128-byte game packet of one team member. Returns "empty", the matching saved
// Digimon, or null. `used`: slots already sent in this match.
export function matchPacket(packet, digimon, used) {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (packet.subarray(0, PACKET_RECORD).every((b) => b === 0)) return "empty";
  const u32 = (o) => view.getUint32(o, true);
  return digimon.find((d) => !used.has(d.slot)
    && u32(0x00) === d.species && u32(0x04) === d.form && u32(0x3c) === d.extra
    && d.name.every((c, k) => view.getUint16(0x08 + k * 2, true) === c) && view.getUint16(0x1a, true) === 0
    && d.stats.every((v, k) => u32(0x1c + k * 4) === v)) ?? null;
}

// For logs: the fields of a relayed Digimon.
export function describePacket(packet) {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const name = [];
  for (let k = 0; k < 10; k++) name.push(view.getUint16(0x08 + k * 2, true));
  return { species: view.getUint32(0, true), name: String.fromCharCode(...name.filter((c) => c)),
    stats: Array.from({ length: 8 }, (_, k) => view.getUint32(0x1c + k * 4, true)) };
}
