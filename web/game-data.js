// The game's tables the server works with: species, stat curves, digivolutions (save-check.js),
// items, mails, cages and names (save-info.js).
// Where the ROM is (a local setup), they are read from it and the text dumps. The hosted server
// has no ROM: it reads game-data.json, written from the ROM by
//
//     node web/game-data.js
//
// Run it after every rebuild of the mod, with tools/make_web_patch.py: `rom` in the file is the
// SHA-256 of the ROM it was read from, which server.js compares with the patch's.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readTables } from "./save-check.js";
import { loadGameInfo } from "./save-info.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(root, "game-data.json");
const DEFAULT_ROM = path.join(root, "..", "build", "digimon_mod.nds");
const TEXT_DIR = path.join(root, "..", "text");
const SPECIES_FIRST = 8, CURVE_ROWS = 25, CURVE_COLUMNS = 8, RANKS = 16, CUPS = 61;

function fromRom(rom, textDir) {
  const tables = readTables(rom), info = loadGameInfo(rom, textDir);
  const count = (n, value) => Array.from({ length: n }, (_, i) => value(i));
  return {
    rom: createHash("sha256").update(rom).digest("hex"),
    tables: {
      species: [...tables.species],
      curves: count(CURVE_ROWS, (row) => count(CURVE_COLUMNS, (col) => tables.curve(row, col))),
      evolutions: [...tables.evolutions],
    },
    info: {
      speciesNames: count(tables.species.size, (i) => info.speciesName(SPECIES_FIRST + i)),
      species: info.species, items: info.items, mails: info.mails, cages: [...info.cages],
      ranks: count(RANKS, info.rankName), cups: count(CUPS, info.cupName),
      statLabels: info.statLabels, apLabels: info.apLabels,
    },
  };
}

// The objects save-check.js readTables and save-info.js loadGameInfo return.
function fromJson({ rom, tables, info }) {
  const { curves } = tables, { speciesNames, ranks, cups } = info;
  return {
    rom,
    tables: {
      species: new Map(tables.species),
      curve: (row, col) => curves[Math.min(row, curves.length - 1)][col],
      evolutions: new Set(tables.evolutions),
    },
    info: {
      ...info, cages: new Map(info.cages),
      speciesName: (s) => (s === 0 ? "DigiEgg" : speciesNames[s - SPECIES_FIRST] ?? `#${s}`),
      rankName: (r) => ranks[r] ?? `rank ${r}`,
      cupName: (t) => cups[t] ?? "",
    },
  };
}

// { rom, tables, info }. Both setups go through the same JSON form, so they behave the same.
export function loadGameData(romPath = DEFAULT_ROM, textDir = TEXT_DIR) {
  if (fs.existsSync(romPath)) return fromJson(fromRom(fs.readFileSync(romPath), textDir));
  if (!fs.existsSync(JSON_PATH)) {
    throw new Error(`No ROM at ${romPath} and no ${JSON_PATH}: write it with "node web/game-data.js" where the ROM is.`);
  }
  return fromJson(JSON.parse(fs.readFileSync(JSON_PATH, "utf8")));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const romPath = process.argv[2] ?? DEFAULT_ROM;
  fs.writeFileSync(JSON_PATH, JSON.stringify(fromRom(fs.readFileSync(romPath), TEXT_DIR)));
  console.log(`${JSON_PATH}: ${fs.statSync(JSON_PATH).size} bytes, from ${romPath}`);
}
