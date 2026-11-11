// Delivers the admins' gifts (web/gifts.js) through the game's own mail, from DS RAM.
// The farm scene (overlay 18) sends the mail whose catalogue index is at G+0x1020 to the mailer
// queue, then sets it back to -1. For a custom gift the page first rewrites catalogue mail 108
// (sender, gift definition) and gift definition 12 in RAM. When the player opens the mail the game
// copies the gift out of the definition and sets the entry's read flag: the page then reports the
// gift delivered. The result line ("You got medicine.") is read from the definition again when
// the mail is closed, and the closed mail leaves the queue: only then does the page put the
// original records back and send the next gift. The page follows its mail by position: with
// one gift in flight, it is the last entry with the mail's record (mails are appended). One that
// leaves the queue unread (expired) leaves the gift pending, sent again later. A Digimon with bonus
// stats: the game hands it over when the mail closes, then the page adds the bonus to its record. A
// Digimon back from the bank (web/bank.js) gets its whole banked struct written over the new record.
// docs/mail_and_save_analysis.md describes the structures.
import { dsMemory, GAME_GLOBAL_PTR } from "./online.js";

const MAIN_RAM = 0x02000000, MAIN_RAM_SIZE = 0x400000;
const G_PENDING_MAIL = 0x1020;   // catalogue index the farm sends next, -1 when none
const G_QUEUE_COUNT = 0xfac, G_QUEUE = 0xfb0, QUEUE_MAX = 4, ENTRY = 0x1c;
const E_SENDER = 0x04, E_BODY = 0x08, E_GIFT = 0x14, E_READ = 0x18;
const CATALOGUE = 0x020f1b94, CAT_RECORD = 24, C_SENDER = 0x00, C_BODY = 0x04, C_GIFT = 0x10;
const GIFT_DEFS = 0x020f2e6c, DEF_RECORD = 0x1c;
const TICK_MS = 500, FETCH_MS = 20_000, PICKUP_MS = 10_000, BONUS_WAIT_MS = 30_000;
// The farm's Digimon (ARM9 0x0206A7A4 and the save loader): 16 records of a "used" word then the
// game's Digimon struct: species at +0, current HP and TP at +0x58, then the stats a bonus raises
// (web/gifts.js MAX_BONUS order) at +0x60.
const FARM_PTR = 0x02103464, FARM_LIST = 8, FARM_SLOTS = 16, FARM_RECORD = 0x1d4, D_STRUCT = 4;
const D_SPECIES = 0, D_HP = 0x58, D_TP = 0x5c, D_STATS = 0x60, D_CAGE = 0x1a0;
const STAT_MAX = [8191, 511, 511, 511, 511, 511];   // what the save's bit fields hold
// Food in the player's struct: the game's item mail ignores item 0, so the page adds it at closing.
const G_PLAYER = 4, P_FOOD = 0x2c, FOOD_MAX = 99;

const i32 = (u) => u | 0;

export function setupGifts() {
  const mem = dsMemory();
  let pending = [];
  let lastFetch = 0;
  let current = null;   // { gift, saved, sig, phase: "queued" | "sent" | "opened", since, count }

  async function fetchPending() {
    lastFetch = Date.now();
    const res = await fetch("/api/gifts/pending");
    if (res.ok) pending = (await res.json()).gifts;
  }

  const words = (addr, n) => Array.from({ length: n }, (_, k) => mem.u32(addr + k * 4));
  const writeWords = (addr, values) => values.forEach((v, k) => mem.setU32(addr + k * 4, v >>> 0));

  // The mail as it appears in the queue: sender, body text and gift definition of its record.
  function signature(mail) {
    const rec = CATALOGUE + mail * CAT_RECORD;
    return { sender: mem.u32(rec + C_SENDER), body: mem.u32(rec + C_BODY), gift: mem.u32(rec + C_GIFT) };
  }

  // The queue entries with this record, in queue order: [{ read }].
  function entries(G, sig) {
    const out = [];
    const count = Math.min(mem.u32(G + G_QUEUE_COUNT), QUEUE_MAX);
    for (let k = 0; k < count; k++) {
      const e = G + G_QUEUE + k * ENTRY;
      if (mem.u32(e + E_SENDER) === sig.sender && mem.u32(e + E_BODY) === sig.body && mem.u32(e + E_GIFT) === sig.gift) {
        out.push({ read: mem.u32(e + E_READ) !== 0 });
      }
    }
    return out;
  }
  const unread = (list) => list.find((e) => !e.read);

  // The structs of the farm's used slots, by slot.
  function farmDigimon() {
    const list = mem.u32(mem.u32(FARM_PTR) + FARM_LIST), out = new Map();
    for (let slot = 0; slot < FARM_SLOTS; slot++) {
      const record = list + slot * FARM_RECORD;
      if (mem.u32(record)) out.set(slot, record + D_STRUCT);
    }
    return out;
  }

  function addFood(G, qty) {
    const at = mem.u32(G + G_PLAYER) + P_FOOD;
    const food = Math.min((mem.u32(at) & 0xffff) + qty, FOOD_MAX);
    mem.write(at, new Uint8Array([food, 0]));
  }

  function addBonus(digimon, bonus) {
    bonus.forEach((b, k) => {
      const at = digimon + D_STATS + k * 4;
      mem.setU32(at, Math.min(mem.u32(at) + b, STAT_MAX[k]));
    });
    mem.setU32(digimon + D_HP, mem.u32(digimon + D_STATS));
    mem.setU32(digimon + D_TP, mem.u32(digimon + D_STATS + 4));
  }

  // A banked Digimon (web/bank.js) comes back: its struct goes over the Digimon the mail gave,
  // all but the cage the game just picked for it.
  function writeBanked(digimon, base64) {
    const struct = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const cage = mem.u32(digimon + D_CAGE);
    mem.write(digimon, struct);
    mem.setU32(digimon + D_CAGE, cage);
  }

  // Waits for the gift's Digimon: a slot of its species that was free when the mail was sent.
  function watchBonus() {
    const { gift, before, since } = current;
    for (const [slot, digimon] of farmDigimon()) {
      if (before.has(slot) || mem.u32(digimon + D_SPECIES) !== gift.species) continue;
      current = null;
      if (gift.bank) {
        writeBanked(digimon, gift.bank.struct);
        fetch("/api/bank/applied", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: gift.bank.id }) }).catch(() => {});
      } else {
        addBonus(digimon, gift.bonus);
      }
      return;
    }
    if (Date.now() - since > BONUS_WAIT_MS) {
      console.error(`gift ${gift.id}: no new Digimon of species ${gift.species}`);
      current = null;
    }
  }

  function restore() {
    const { saved } = current;
    if (saved) {
      mem.setU32(saved.rec + C_SENDER, saved.sender);
      writeWords(saved.defAddr, saved.def);
    }
    current = null;
  }

  function send(G, gift) {
    const before = gift.bonus || gift.bank ? new Set(farmDigimon().keys()) : null;
    let saved = null;
    if (gift.def) {
      const rec = CATALOGUE + gift.mail * CAT_RECORD, defAddr = GIFT_DEFS + gift.defIndex * DEF_RECORD;
      saved = { rec, sender: mem.u32(rec + C_SENDER), defAddr, def: words(defAddr, 7) };
      mem.setU32(rec + C_SENDER, gift.sender);
      writeWords(defAddr, gift.def);
    }
    current = { gift, saved, sig: signature(gift.mail), phase: "queued", since: Date.now(), count: null, before };
    mem.setU32(G + G_PENDING_MAIL, gift.mail);
  }

  async function tick() {
    if (!current && Date.now() - lastFetch > FETCH_MS) await fetchPending();
    if (!mem.ready()) return;
    const G = mem.u32(GAME_GLOBAL_PTR);
    if (G < MAIN_RAM || G >= MAIN_RAM + MAIN_RAM_SIZE) return;   // game not running yet
    if (current?.phase === "bonus") return watchBonus();

    if (current?.phase === "queued") {
      if (i32(mem.u32(G + G_PENDING_MAIL)) === -1) Object.assign(current, { phase: "sent", since: Date.now() });
      return;
    }
    const list = current ? entries(G, current.sig) : [];
    if (current?.phase === "opened") {
      if (list.some((e) => e.read)) return;
      const { gift, before } = current;
      restore();   // mail closed
      if (gift.food) addFood(G, gift.food);
      if (gift.bonus || gift.bank) current = { gift, before, phase: "bonus", since: Date.now() };
      return;
    }
    if (current?.phase === "sent") {
      const last = list.at(-1);
      if (last && !last.read) {
        current.count = list.length;
      } else if (current.count === list.length && last?.read) {
        const { id } = current.gift;
        current.phase = "opened";
        pending = pending.filter((g) => g.id !== id);
        await fetch(`/api/gifts/${id}/delivered`, { method: "POST" });
      } else if (current.count !== null || Date.now() - current.since > PICKUP_MS) {
        restore();   // expired unread (or never queued): the gift stays pending
        lastFetch = 0;
      }
      return;
    }

    const gift = pending[0];
    if (!gift || i32(mem.u32(G + G_PENDING_MAIL)) !== -1 || mem.u32(G + G_QUEUE_COUNT) >= QUEUE_MAX) return;
    // An unread mail of the game with the record about to change: wait until it is read or gone.
    if (gift.def && unread(entries(G, signature(gift.mail)))) return;
    send(G, gift);
  }

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (err) { console.error(err); } finally { busy = false; }
  }, TICK_MS);

  return {
    phase: () => current?.phase ?? null,
    // A gift waits on the server (web/presence.js said so): fetch it at the next tick.
    refresh() { if (!current) lastFetch = 0; },
  };
}
