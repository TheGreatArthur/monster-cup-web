// Anti-cheat referee (step 3, docs/anti_cheat_strategy.md R5): replays one side of an online match
// in the emulator. The game loads that player's save as it was when the battle started, the
// opponent's packets come from the match journal instead of the network, and the server's seed
// is loaded as in the real match. The page then compares the packets its game sends with the
// ones the player's page relayed, and reads who won. web/referee/worker.py drives the menus.
import {
  dsMemory, GAME_GLOBAL_PTR, MAILBOX, MAILBOX_MAGIC, MB_ROLE, MB_OUT, MB_IN, MB_CONNECTED, MB_SEED,
  SEND_BUFFER, RECV_BUFFER, PACKET_SIZE, G_ROUNDS_PLAYED, G_ROUNDS, G_ROUND_WON,
} from "./online.js";

const EJS_DATA = "https://cdn.emulatorjs.org/4.2.3/data/";
const FARM_HOLDER = 0x02103464;   // *(holder + 8): the 16 farm slots, 0x1D4 bytes each (u32 flag + Digimon)
const FARM_SLOT = 0x1d4;
const G_TEAM = 0x160, G_TERRAIN = 0xce4;
const TEAM_SIZE = 0x4c, TEAM_POINTERS = 0x1c, TEAM_POINTERS_END = 0x28;
// Who sends each packet and how many bytes of it the game fills (web/online.js EXCHANGE): terrain,
// team names, teams (their Digimon pointers are RAM addresses, not compared), team members.
const EXCHANGE = "HGH" + "HG" + "HGHGHG";
const PACKET_LENGTH = [4, 18, 18, TEAM_SIZE, TEAM_SIZE, 0x6c, 0x6c, 0x6c, 0x6c, 0x6c, 0x6c];
const POLL_MS = 16;

const statusEl = document.getElementById("referee-status");
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const show = (text) => { statusEl.textContent = text; };

// State the worker reads: ready (game booted), phase, done, error.
const referee = window.referee = { ready: false, phase: "boot", done: false, error: null, setTeam };

const params = new URLSearchParams(location.search);
const job = await (await fetch(`/api/referee/job?match=${params.get("match")}&side=${params.get("side")}`)).json();
const mine = job.role === 1 ? "H" : "G";
const ownIndexes = [...EXCHANGE].flatMap((who, i) => (who === mine ? [i] : []));
const recorded = job.packets.map(fromBase64);
const incoming = [...EXCHANGE].flatMap((who, i) => (who === mine ? [] : [recorded[i]]));   // opponent's
const sent = [];        // packets this game sent, in order
const mem = dsMemory();

function hasMailbox() {
  return String.fromCharCode(...mem.bytes(MAILBOX, MAILBOX_MAGIC.length)) === MAILBOX_MAGIC;
}

// The team the player picked, from the journal: its Digimon are the save slots the server matched
// (web/online.js checkMember), the rest (name, strategies, presence mask) is the relayed team.
function setTeam() {
  const team = mem.u32(GAME_GLOBAL_PTR) + G_TEAM;
  const relayed = recorded[ownIndexes[ownIndexes.length - 4]];   // the side's team packet
  mem.write(team, relayed.subarray(0, TEAM_POINTERS));
  mem.write(team + TEAM_POINTERS_END, relayed.subarray(TEAM_POINTERS_END, TEAM_SIZE));
  const farm = mem.u32(mem.u32(FARM_HOLDER) + 8);
  job.slots.forEach((slot, k) => {
    mem.setU32(team + TEAM_POINTERS + 4 * k, slot === null ? 0 : farm + slot * FARM_SLOT + 4);
  });
  return job.slots;
}

function link() {
  mem.setU32(MAILBOX + MB_ROLE, job.role);
  mem.setU32(MAILBOX + MB_SEED, job.seed);
  mem.setU32(MAILBOX + MB_CONNECTED, 1);
  if (mem.u32(MAILBOX + MB_OUT) === 1) {
    const index = ownIndexes[sent.length];
    if (index === 0) {
      // The host draws the terrain at random: use the one the real host sent.
      const g = mem.u32(GAME_GLOBAL_PTR);
      mem.write(g + G_TERRAIN, recorded[0].subarray(0, 4));
      mem.write(SEND_BUFFER, recorded[0].subarray(0, 4));
    }
    sent.push(mem.bytes(SEND_BUFFER, PACKET_SIZE));
    mem.setU32(MAILBOX + MB_OUT, 2);
  }
  if (mem.u32(MAILBOX + MB_IN) === 0 && incoming.length) {
    mem.write(RECV_BUFFER, incoming.shift());
    mem.setU32(MAILBOX + MB_IN, 1);
  }
}

// Packets of this side that differ from the relayed ones (indexes in the exchange).
function mismatches() {
  return ownIndexes.filter((index, k) => {
    const a = sent[k], b = recorded[index];
    if (!a) return true;
    for (let i = 0; i < PACKET_LENGTH[index]; i++) {
      if (index >= 3 && index <= 4 && i >= TEAM_POINTERS && i < TEAM_POINTERS_END) continue;
      if (a[i] !== b[i]) return true;
    }
    return false;
  });
}

async function finish(won) {
  referee.phase = "done";
  // The team records this game built from the save (the server learns them, web/referee.js).
  const members = ownIndexes.flatMap((index, k) => (index >= 5 && sent[k]
    ? [btoa(String.fromCharCode(...sent[k].subarray(0, PACKET_LENGTH[index])))] : []));
  const verdict = { match: job.match, side: job.side, won, mismatches: mismatches(), members };
  show(JSON.stringify(verdict));
  await fetch("/api/referee/verdict", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(verdict),
  });
  referee.done = true;
}

function poll() {
  if (!referee.ready || !mem.ready() || referee.phase === "done") return;
  if (hasMailbox()) {
    referee.phase = "link";
    link();
    return;
  }
  if (referee.phase === "link") {
    referee.phase = "battle";
    try { window.EJS_emulator.gameManager.toggleFastForward(1); } catch { /* normal speed */ }
  }
  if (referee.phase !== "battle" && referee.phase !== "playing") return;
  const g = mem.u32(GAME_GLOBAL_PTR);
  const played = mem.u32(g + G_ROUNDS_PLAYED), rounds = mem.u32(g + G_ROUNDS);
  if (referee.phase === "battle" && rounds > 0 && played < rounds) referee.phase = "playing";
  if (referee.phase !== "playing" || played < rounds) return;
  let won = true;
  for (let i = 0; i < rounds; i++) if (!mem.u32(g + G_ROUND_WON + 4 * i)) won = false;
  finish(won).catch((err) => { referee.error = String(err); });
}

async function onGameStart() {
  const gm = window.EJS_emulator.gameManager;
  const file = gm.getSaveFilePath();
  gm.FS.mkdirTree(file.slice(0, file.lastIndexOf("/")));
  gm.FS.writeFile(file, fromBase64(job.save));
  gm.loadSaveFiles();
  gm.restart();
  referee.ready = true;
  show(`Match ${job.match}, ${job.side} : en cours`);
  setInterval(poll, POLL_MS);
}

Object.assign(window, {
  EJS_player: "#game",
  EJS_core: "melonds",
  EJS_gameUrl: `/rom/referee-${job.romVersion}.nds`,
  EJS_gameName: "Digimon World Championship",
  EJS_pathtodata: EJS_DATA,
  EJS_language: "en-US",
  EJS_defaultOptions: { melonds_touch_mode: "Touch" },
  EJS_backgroundColor: "#000000",
  EJS_startOnLoaded: true,
  EJS_onGameStart: onGameStart,
});
const loader = document.createElement("script");
loader.src = `${EJS_DATA}loader.js`;
document.body.append(loader);
