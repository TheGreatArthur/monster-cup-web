// Online battles: the game's Online Arena (Battle → Multi Battle) talks to the server through this
// page. The ROM patch patches/online_mailbox.json (tools/make_online_patch.py) turns the game's
// "Wireless Communication" transport into a mailbox in DS RAM; this module reads and writes it
// through the emulator's memory (EmulatorJS melonDS core, Emscripten heap). The game posts its
// commands there (create a room, join one, ranked match, cancel); the page runs them on the
// server, relays the battle packets, hands the game the match's seed and reports the outcome.
// The page itself has no match controls: it only shows the status.
const MAIN_RAM = 0x02000000;
const MAIN_RAM_SIZE = 0x400000;
// 32 bytes of the Digimon table (ARM9 0x020C1D98), used to find DS main RAM in the heap.
const RAM_SIGNATURE_ADDR = 0x020c1d98;
const RAM_SIGNATURE = Uint8Array.from("2cf60b02c80b0c02ecf90b0201000000000000000000000000000000060c0c00"
  .match(/../g), (h) => parseInt(h, 16));
export const GAME_GLOBAL_PTR = 0x02103468;   // G, the game's global state

export const MAILBOX = 0x02179c60;
export const MAILBOX_MAGIC = "WEBMBOX1";
export const MB_ROLE = 0x08, MB_OUT = 0x0c, MB_IN = 0x10, MB_CONNECTED = 0x14, MB_DISCONNECTED = 0x18, MB_SEED = 0x20;
// Commands: the game writes (sequence << 8) | kind; code is the room code of a create or join;
// the page keeps a fresh 6-digit code in offer for the next Create Room.
export const MB_COMMAND = 0x24, MB_CODE = 0x28, MB_OFFER = 0x2c;
export const CMD_CREATE = 1, CMD_JOIN = 2, CMD_RANKED = 3, CMD_CANCEL = 4;
// The text (text/txt_list_txt.json) the game's error screen shows once disconnected is set; the
// game clears it. 0: "A communication error has occurred." (1411).
export const MB_MESSAGE = 0x30;
export const TEXT_LEFT = 1414, TEXT_UNREACHABLE = 1422, TEXT_CANCELLED = 1423;
// The server's refusals (web/online.js, web/sanctions.js), by reason.
export const REFUSAL_TEXTS = {
  invalid_code: 1415, room_not_found: 1415, own_room: 1416, code_taken: 1417, rate_limited: 1418,
  ranked_banned: 1419, ranked_flagged: 1420, ranked_too_new: 1421,
};
export const SEND_BUFFER = 0x0219a340;
export const RECV_BUFFER = 0x0219a3c0;
export const PACKET_SIZE = 0x80;
// Battle rounds in G (written by the battle, overlay 19): rounds played, rounds to play, and one
// u32 per round, non-zero when this DS's team won it. The game's result screen (overlay 8) shows
// a win when every round was won; the page reports the same.
export const G_ROUNDS_PLAYED = 0xcec, G_ROUNDS = 0xcf0, G_ROUND_WON = 0xcf4;
const POLL_MS = 16;

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const post = (url, body = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// DS main RAM inside the emulator heap. The heap view is taken again on each access: it is
// replaced when the heap grows.
export function dsMemory() {
  let base = null;
  const heap = () => window.EJS_emulator?.gameManager?.Module?.HEAPU8;
  const view = () => new DataView(heap().buffer);

  function find() {
    const h = heap();
    if (!h) return null;
    const sig = RAM_SIGNATURE;
    for (let i = h.indexOf(sig[0]); i >= 0 && i < h.length - sig.length; i = h.indexOf(sig[0], i + 1)) {
      let k = 1;
      while (k < sig.length && h[i + k] === sig[k]) k++;
      if (k < sig.length) continue;
      const candidate = i - (RAM_SIGNATURE_ADDR - MAIN_RAM);
      // The ROM image holds the same bytes; main RAM is the copy whose game pointer is set.
      const ptr = new DataView(h.buffer).getUint32(candidate + GAME_GLOBAL_PTR - MAIN_RAM, true);
      if (ptr >= MAIN_RAM && ptr < MAIN_RAM + MAIN_RAM_SIZE) return candidate;
    }
    return null;
  }

  const at = (addr) => base + addr - MAIN_RAM;
  return {
    ready() {
      if (base === null) base = find();
      return base !== null;
    },
    u32: (addr) => view().getUint32(at(addr), true),
    setU32: (addr, value) => view().setUint32(at(addr), value, true),
    bytes: (addr, size) => heap().slice(at(addr), at(addr) + size),
    write: (addr, bytes) => heap().set(bytes, at(addr)),
  };
}

// syncSave: uploads the game's save when it changed (play.js). The server checks the Digimon a
// game sends in a ranked match against the save it holds, so it must be up to date.
export function setupOnline({ syncSave }) {
  const mem = dsMemory();
  let events = null;
  let match = null;          // { role, opponent, seed, ranked }
  let incoming = [];         // packets waiting for the game's receive buffer
  let sending = Promise.resolve();
  let opponentLeft = false;
  // Battle tracking: "link" while overlay 9 (the mailbox) is loaded, "battle" once it is gone,
  // "playing" once a round is under way, "done" once the result is reported.
  let phase = null;
  // Last command sequence handled. The mailbox is part of overlay 9: it is back to its initial
  // values, sequence 0, each time the Multi Battle scene loads.
  let lastSeq = null;
  let commandsDone = Promise.resolve();   // the commands' server calls, one after the other
  let active = false;        // a room, search or match is open on the server

  // Ends the game's wait: its error screen shows the text.
  const fail = (text) => {
    if (!mem.ready() || !hasMailbox()) return;
    mem.setU32(MAILBOX + MB_MESSAGE, text);
    mem.setU32(MAILBOX + MB_DISCONNECTED, 1);
  };
  const inBattle = () => phase === "battle" || phase === "playing" || phase === "done";

  function reset() {
    match = null;
    incoming = [];
    opponentLeft = false;
    phase = null;
  }

  function openEvents() {
    if (events) return;
    events = new EventSource("/api/online/events");
    events.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      // A win paid PvP coins: the shop panel shows the new balance (shop.js).
      if (event.coins !== undefined) window.dispatchEvent(new CustomEvent("dwc-coins", { detail: event.coins }));
      if (event.type === "matched") {
        // The seed comes later, when the team exchange starts.
        match = { role: event.role, opponent: event.opponent, seed: 0, ranked: event.ranked };
        syncSave?.();
      } else if (event.type === "seed") {
        if (match) match.seed = event.seed;
      } else if (event.type === "packet") {
        incoming.push(fromBase64(event.data));
      } else if (event.type === "left") {
        opponentLeft = true;
        if (!inBattle() && mem.ready() && hasMailbox()) mem.setU32(MAILBOX + MB_MESSAGE, TEXT_LEFT);
      } else if (event.type === "result") {
        active = false;
        // A game still waiting on the link quits its waiting screen.
        if (phase !== null && !inBattle()) fail(event.reason === "left" ? TEXT_LEFT : TEXT_CANCELLED);
        reset();
      }
    };
  }

  // A refused request ends the game's wait: its error screen says why, then the menu is back.
  async function start(url, body) {
    reset();
    openEvents();
    if (hasMailbox()) {
      mem.setU32(MAILBOX + MB_CONNECTED, 0);
      mem.setU32(MAILBOX + MB_DISCONNECTED, 0);
      mem.setU32(MAILBOX + MB_MESSAGE, 0);
    }
    let res;
    try {
      res = await post(url, body);
    } catch {
      fail(TEXT_UNREACHABLE);
      return;
    }
    const reply = await res.json().catch(() => ({}));
    if (!res.ok) {
      fail(REFUSAL_TEXTS[reply.reason] ?? 0);
      return;
    }
    active = true;
  }

  async function run(kind, code) {
    if (kind === CMD_CREATE) {
      await start("/api/online/room", { code });
    } else if (kind === CMD_JOIN) {
      await start("/api/online/join", { code });
    } else if (kind === CMD_RANKED) {
      await start("/api/online/search");
    } else if (kind === CMD_CANCEL && !inBattle()) {
      // Back on the Online Arena menu. Once the battle started, leaving would be a forfeit: the
      // result settles the match instead.
      const open = active || match;
      active = false;
      reset();
      if (hasMailbox()) {
        mem.setU32(MAILBOX + MB_CONNECTED, 0);
        mem.setU32(MAILBOX + MB_DISCONNECTED, 0);
        mem.setU32(MAILBOX + MB_MESSAGE, 0);
      }
      if (open) await post("/api/online/leave");
    }
  }

  // The game's commands, posted by the Online Arena menu.
  function commands() {
    if (!mem.u32(MAILBOX + MB_OFFER)) mem.setU32(MAILBOX + MB_OFFER, 100000 + Math.floor(Math.random() * 900000));
    const command = mem.u32(MAILBOX + MB_COMMAND), seq = command >>> 8;
    if (lastSeq === null) lastSeq = 0;
    if (seq === lastSeq) return;
    lastSeq = seq;
    const kind = command & 0xff, code = String(mem.u32(MAILBOX + MB_CODE)).padStart(6, "0");
    commandsDone = commandsDone.then(() => run(kind, code)).catch(() => {});
  }

  function hasMailbox() {
    return String.fromCharCode(...mem.bytes(MAILBOX, MAILBOX_MAGIC.length)) === MAILBOX_MAGIC;
  }

  function relay(bytes) {
    // Sent one after the other so the opponent gets the packets in order.
    sending = sending.then(() => post("/api/online/send", { data: toBase64(bytes) })).catch(() => {});
  }

  function link() {
    phase = "link";
    mem.setU32(MAILBOX + MB_ROLE, match.role);
    mem.setU32(MAILBOX + MB_SEED, match.seed);
    mem.setU32(MAILBOX + MB_DISCONNECTED, opponentLeft ? 1 : 0);
    if (!mem.u32(MAILBOX + MB_CONNECTED)) {
      mem.setU32(MAILBOX + MB_CONNECTED, 1);
    }
    if (mem.u32(MAILBOX + MB_OUT) === 1) {
      relay(mem.bytes(SEND_BUFFER, PACKET_SIZE));
      mem.setU32(MAILBOX + MB_OUT, 2);
    }
    if (mem.u32(MAILBOX + MB_IN) === 0 && incoming.length) {
      mem.write(RECV_BUFFER, incoming.shift());
      mem.setU32(MAILBOX + MB_IN, 1);
    }
  }

  // After the link: the battle runs on its own; report once its last round is over.
  function watchBattle() {
    const g = mem.u32(GAME_GLOBAL_PTR);
    const played = mem.u32(g + G_ROUNDS_PLAYED), rounds = mem.u32(g + G_ROUNDS);
    if (phase === "battle" && rounds > 0 && played < rounds) phase = "playing";
    if (phase !== "playing" || played < rounds) return;
    phase = "done";
    let won = true;
    for (let i = 0; i < rounds; i++) if (!mem.u32(g + G_ROUND_WON + 4 * i)) won = false;
    post("/api/online/result", { won });
  }

  function poll() {
    if (!mem.ready()) return;
    const present = hasMailbox();
    if (present) commands();
    else lastSeq = null;
    if (!match) return;
    if (present && !inBattle()) link();
    else if (!present && phase === "link") phase = "battle";
    if (phase === "battle" || phase === "playing") watchBattle();
  }
  setInterval(poll, POLL_MS);
}
