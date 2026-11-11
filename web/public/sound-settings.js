// Sound settings (the gear in the play page bar): the emulator's master volume, and the volume of
// each of the game's sound players, kept in this browser.
//
// The game plays its sounds through NitroSystem's sound archive (sound_data.sdat). It has four
// sequence players: 0 menus (PLAYER_UI), 1 effects (PLAYER_SE), 2 ambience loops (PLAYER_LOOP),
// 3 music (PLAYER_SEQ, the field and menu music). NitroSystem keeps one record per player in DS
// RAM; the byte at +0x20 is the player volume (0 to 127, 127 by default) and the sound engine
// applies it to every sound the player plays, so writing it there turns that part down. The
// battle music is streamed (STRM_BATTLE_*) and follows only the master volume.
import { dsMemory } from "./online.js";

const STORE = "dwc-sound";
const PLAYER_TABLE = 0x0210ad84;
const PLAYER_STRIDE = 0x24;
const PLAYER_VOLUME = 0x20;
// What the table looks like (checked before any write): the play list's link offset at +0x0a
// and each player's sequence count at +0x18 (sound_data.sdat: 2, 2, 1, 1).
const LIST_OFFSET = 0x0a, SEQ_COUNT = 0x18;
const SEQ_COUNTS = [2, 2, 1, 1];
const APPLY_MS = 500;

const CHANNELS = [
  { key: "master", label: "Master volume" },
  { key: "music", label: "Music", player: 3 },
  { key: "ambience", label: "Ambience", player: 2 },
  { key: "effects", label: "Sound effects", player: 1 },
  { key: "menus", label: "Menu sounds", player: 0 },
];
const DEFAULTS = { master: 50, music: 100, ambience: 100, effects: 100, menus: 100 };

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const n = Number(saved[key]);
      if (Number.isFinite(n)) out[key] = Math.min(100, Math.max(0, Math.round(n)));
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

function store(levels) {
  try { localStorage.setItem(STORE, JSON.stringify(levels)); } catch { /* kept for this visit only */ }
}

// The master volume EmulatorJS starts with (play.js passes it as EJS_volume).
export const startVolume = () => load().master / 100;

export function setupSoundSettings() {
  const levels = load();
  const mem = dsMemory();
  let touched = false;        // the game's volumes were written at least once
  let masterApplied = false;

  const byte = (addr) => mem.bytes(addr, 1)[0];
  const u16 = (addr) => { const b = mem.bytes(addr, 2); return b[0] | (b[1] << 8); };
  const record = (player) => PLAYER_TABLE + player * PLAYER_STRIDE;
  const tableLooksRight = () => SEQ_COUNTS.every((count, p) =>
    u16(record(p) + LIST_OFFSET) === 0x0c && u16(record(p) + SEQ_COUNT) === count);

  function apply() {
    const emu = window.EJS_emulator;
    if (!emu?.started) return;
    if (!masterApplied && typeof emu.setVolume === "function") {
      // EmulatorJS keeps its own volume (and restores it from its own settings at start).
      emu.volume = levels.master / 100;
      emu.muted = false;
      emu.setVolume(emu.volume);
      masterApplied = true;
    }
    // Nothing to write while every part plays at full volume, as the game leaves it.
    const wanted = CHANNELS.filter((c) => c.player !== undefined && levels[c.key] !== 100);
    if (!wanted.length && !touched) return;
    try {
      if (!mem.ready() || !tableLooksRight()) return;
      for (const c of CHANNELS) {
        if (c.player === undefined) continue;
        const addr = record(c.player) + PLAYER_VOLUME;
        const value = Math.round((levels[c.key] / 100) * 127);
        if (byte(addr) !== value) mem.write(addr, Uint8Array.of(value));
      }
      touched = true;
    } catch (err) {
      console.error("sound settings:", err);
    }
  }

  // --- the panel ---
  const button = document.getElementById("sound-button");
  const dialog = document.getElementById("sound-settings");
  const list = document.getElementById("sound-levels");
  // Arrow keys on a slider must not press the game's buttons: EmulatorJS listens on the document.
  for (const type of ["keydown", "keyup", "keypress"]) dialog.addEventListener(type, (e) => e.stopPropagation());

  const inputs = {};
  for (const c of CHANNELS) {
    const id = `sound-${c.key}`;
    const row = document.createElement("li");
    row.className = c.key === "master" ? "sound-row master" : "sound-row";
    row.innerHTML = `<label for="${id}">${c.label}</label><output for="${id}"></output>`
      + `<input type="range" id="${id}" min="0" max="100" step="5">`;
    const input = row.querySelector("input");
    const value = row.querySelector("output");
    const show = () => {
      value.textContent = levels[c.key] === 0 ? "Off" : `${levels[c.key]}%`;
      input.style.setProperty("--fill", `${levels[c.key]}%`);
    };
    input.value = String(levels[c.key]);
    input.addEventListener("input", () => {
      levels[c.key] = Number(input.value);
      if (c.key === "master") masterApplied = false;
      show();
      store(levels);
      apply();
    });
    show();
    inputs[c.key] = { input, show };
    list.append(row);
  }

  document.getElementById("sound-reset").addEventListener("click", () => {
    Object.assign(levels, DEFAULTS);
    masterApplied = false;
    for (const c of CHANNELS) {
      inputs[c.key].input.value = String(levels[c.key]);
      inputs[c.key].show();
    }
    store(levels);
    apply();
  });
  button.addEventListener("click", () => {
    dialog.showModal();
    button.setAttribute("aria-expanded", "true");
  });
  dialog.addEventListener("close", () => button.setAttribute("aria-expanded", "false"));
  // A click on the backdrop closes the panel.
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

  // The game may reset a player's volume (a new scene, a restart): write it again.
  setInterval(apply, APPLY_MS);
}
