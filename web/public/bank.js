// The bank tab of the play page's left panel (hub.js): the player's banked Digimon (web/bank.js),
// trades with other players and the public trade board.
//
// Deposit: the page reads the farm's Digimon in DS RAM, sends the chosen one's struct to the server
// and, once the server took it, turns its farm record off: the game no longer saves it. Its sprite
// stays on the farm until the farm is drawn again (after an outing, the next day). The deposit is
// complete when the game saves without it (the end of the day). Withdraw: a gift brings it back by
// mail (gifts.js writes the banked struct over the new Digimon).
import { dsMemory, GAME_GLOBAL_PTR } from "./online.js";
import { api, confirmButton, digimonIcon, el, savedStats, statTable } from "./hub.js";

const MAIN_RAM = 0x02000000, MAIN_RAM_SIZE = 0x400000;
const FARM_PTR = 0x02103464, FARM_LIST = 8, FARM_SLOTS = 16, FARM_RECORD = 0x1d4, D_STRUCT = 4, STRUCT_SIZE = 0x1d0;
const S_SPECIES = 0, S_NAME = 0x2c, NAME_CHARS = 9, S_STATS = 0x58;
// The struct bytes that tell one Digimon from another: species, name, max HP/TP and the four stats.
const SAME = [[S_SPECIES, 4], [S_NAME, S_NAME + NAME_CHARS * 2], [S_STATS + 8, S_STATS + 32]];
const STATUS = {
  pending: "On its way: stored when the game saves (end of the day)",
  stored: "In the bank",
  event: "Handed over to an event",
  withdrawing: "Coming back by mail",
  out: "Back on the farm",
};
const inRam = (a) => a >= MAIN_RAM && a < MAIN_RAM + MAIN_RAM_SIZE;

export function setupBank(root, ctx) {
  const mem = dsMemory();
  let data = { rows: [], incoming: [], outgoing: [], board: [], speciesNames: {} };
  let tab = "mine", view = null;   // view: null | { farm } | { player, rows, take } | { take, owner }
  let resumed = false;

  const speciesName = (id) => data.speciesNames[id] ?? `#${id}`;
  const stored = () => data.rows.filter((r) => r.status === "stored");

  // --- the farm in RAM ---------------------------------------------------------------------

  function farmList() {
    if (!mem.ready()) return null;
    const G = mem.u32(GAME_GLOBAL_PTR), H = mem.u32(FARM_PTR);
    if (!inRam(G) || !inRam(H) || !inRam(mem.u32(H + FARM_LIST))) return null;
    const list = mem.u32(H + FARM_LIST), out = [];
    for (let slot = 0; slot < FARM_SLOTS; slot++) {
      const record = list + slot * FARM_RECORD;
      if (!(mem.u32(record) & 0xff)) continue;
      const s = record + D_STRUCT;
      const species = mem.u32(s + S_SPECIES);
      if (!species) continue;   // a DigiEgg
      const name = String.fromCharCode(...Array.from({ length: NAME_CHARS }, (_, k) => mem.u32(s + S_NAME + k * 2) & 0xffff)
        .filter((c) => c));
      out.push({ slot, record, species, name, stats: Array.from({ length: 8 }, (_, k) => mem.u32(s + S_STATS + k * 4)) });
    }
    return out;
  }

  async function deposit(d) {
    if (ctx.gifts.phase()) return ctx.say("A mail is on its way in the game: wait until it is opened.", "error");
    const before = mem.bytes(d.record + D_STRUCT, STRUCT_SIZE);
    try {
      await ctx.syncSave();   // the server must know the game's last save before the Digimon leaves
      await api("/api/bank/deposit", { struct: btoa(String.fromCharCode(...before)) });
    } catch (err) {
      return ctx.say(err.message, "error");
    }
    // Still the same Digimon in that record (species, name, max stats: its timers keep running):
    // turn it off, the game will not save it any more.
    const now = mem.bytes(d.record + D_STRUCT, STRUCT_SIZE);
    if (mem.u32(d.record) & 0xff && SAME.every(([from, to]) => now.slice(from, to).every((b, k) => b === before[from + k]))) {
      mem.setU32(d.record, 0);
    }
    ctx.say(`${d.name} left your farm for the bank. It is stored once the game saves at the end of the day.`, "ok");
    view = null;
    await refresh();
  }

  // --- views ---------------------------------------------------------------------------------

  const back = (text = "Back") => {
    const b = el("button", { type: "button", className: "back", textContent: text });
    b.addEventListener("click", () => { view = null; render(); });
    return b;
  };

  function digimonRow(d, extra = [], sub = null) {
    return el("li", { className: "bank-row" },
      el("span", { className: "offer-icon" }, digimonIcon(d.species, 32, d.speciesName ?? speciesName(d.species))),
      el("details", { className: "offer-name" },
        el("summary", {}, el("b", { textContent: d.name }), el("small", { textContent: sub ?? d.speciesName ?? speciesName(d.species) })),
        statTable(savedStats(d.stats))),
      el("span", { className: "row-actions" }, ...extra));
  }

  function farmView() {
    const list = farmList();
    const body = list === null
      ? el("p", { className: "empty", textContent: "Go to your farm in the game first." })
      : list.length ? el("ul", { className: "bank-list" }, ...list.map((d) => digimonRow(d,
        [confirmButton("Deposit", "Sure?", () => deposit(d), "primary small")])))
        : el("p", { className: "empty", textContent: "No Digimon on your farm." });
    return [back(), el("h3", { textContent: "Deposit from your farm" }),
      el("p", { className: "hint", textContent: "Only a Digimon already in your saved game can go: the game saves at the end of each day." }),
      body];
  }

  // Pick which of my stored Digimon to give for `take` (another player's).
  function offerView(take, owner) {
    const mine = stored();
    return [back(), el("h3", { textContent: `Trade for ${take.name}` }),
      el("ul", { className: "bank-list" }, digimonRow(take, [], `${take.speciesName}, ${owner.name}'s`)),
      el("p", { className: "hint", textContent: "Pick the Digimon you give. If they accept, each gets the other's in their bank." }),
      mine.length ? el("ul", { className: "bank-list" }, ...mine.map((d) => digimonRow(d,
        [confirmButton("Offer", "Send?", () => sendOffer(d, take), "primary small")])))
        : el("p", { className: "empty", textContent: "You have no stored Digimon to give." })];
  }

  async function sendOffer(give, take) {
    try {
      await api("/api/bank/trade", { give: give.id, take: take.id });
      ctx.say(`Offer sent: your ${give.name} for ${take.name}.`, "ok");
      view = null;
      tab = "offers";
      await refresh();
    } catch (err) { ctx.say(err.message, "error"); }
  }

  function playerView() {
    const form = el("form", { className: "bank-search" });
    const input = el("input", { type: "search", maxLength: 32, placeholder: "Player name", value: view.query ?? "" });
    input.setAttribute("aria-label", "Player name");
    form.append(input, el("button", { type: "submit", className: "primary small", textContent: "Look" }));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await api(`/api/bank/player?name=${encodeURIComponent(input.value.trim())}`);
        view = { player: res.player, rows: res.rows, query: input.value };
      } catch (err) {
        view = { player: null, rows: [], query: input.value };
        ctx.say(err.message, "error");
      }
      render();
    });
    const list = view.player ? (view.rows.length ? el("ul", { className: "bank-list" }, ...view.rows.map((d) => {
      const b = el("button", { type: "button", className: "primary small", textContent: "Ask" });
      b.addEventListener("click", () => { view = { take: d, owner: view.player }; render(); });
      return digimonRow(d, [b]);
    })) : el("p", { className: "empty", textContent: `${view.player.name} has no Digimon in the bank.` })) : null;
    return [back(), el("h3", { textContent: "Trade with a player" }), form, list];
  }

  function mineTab() {
    const deposit = el("button", { type: "button", className: "primary small", textContent: "Deposit from farm" });
    deposit.addEventListener("click", () => { view = { farm: true }; render(); });
    const trade = el("button", { type: "button", className: "ghost small", textContent: "Trade with a player" });
    trade.addEventListener("click", () => { view = { player: null, rows: [] }; render(); });
    const rows = data.rows.map((d) => {
      const actions = [];
      if (d.status === "stored") {
        actions.push(confirmButton("Withdraw", "Sure?", () => act("withdraw", { id: d.id },
          `${d.name} comes back by mail: open your mail on the farm.`), "ghost small"));
        const board = el("button", { type: "button", className: `ghost small${d.listed ? " on" : ""}`,
          textContent: d.listed ? "On board" : "To board", title: "Show it on the public trade board" });
        board.addEventListener("click", () => act("list", { id: d.id, listed: !d.listed },
          d.listed ? `${d.name} left the board.` : `${d.name} is on the trade board.`));
        actions.push(board);
      }
      const status = d.status === "event" && d.event ? `Handed over: ${d.event}` : STATUS[d.status];
      return digimonRow(d, actions, `${d.speciesName}. ${status}`);
    });
    return [el("div", { className: "bank-actions" }, deposit, trade),
      rows.length ? el("ul", { className: "bank-list" }, ...rows)
        : el("p", { className: "empty", textContent: "Your bank is empty. Deposit a Digimon to keep it safe or to trade it." })];
  }

  function offersTab() {
    const incoming = data.incoming.map((t) => el("li", { className: "trade" },
      el("p", {}, el("b", { textContent: t.from.name }), " offers"),
      el("ul", { className: "bank-list" }, digimonRow(t.give, [], t.give.speciesName)),
      el("p", {}, "for your"),
      el("ul", { className: "bank-list" }, digimonRow(t.take, [], t.take.speciesName)),
      el("div", { className: "row-actions" },
        confirmButton("Accept", "Trade?", () => act("accept", { id: t.id }, `Trade done: ${t.give.name} is in your bank.`), "primary small"),
        confirmButton("Decline", "Sure?", () => act("decline", { id: t.id }, "Offer declined."), "ghost small"))));
    const outgoing = data.outgoing.map((t) => el("li", { className: "trade" },
      el("p", {}, "You offer ", el("b", { textContent: t.give.name }), ` for ${t.to.name}'s `, el("b", { textContent: t.take.name })),
      el("div", { className: "row-actions" },
        confirmButton("Cancel", "Sure?", () => act("cancel", { id: t.id }, "Offer cancelled."), "ghost small"))));
    return [el("h4", { textContent: "Offers for you" }),
      incoming.length ? el("ul", { className: "trade-list" }, ...incoming) : el("p", { className: "empty", textContent: "No offer yet." }),
      el("h4", { textContent: "Your offers" }),
      outgoing.length ? el("ul", { className: "trade-list" }, ...outgoing) : el("p", { className: "empty", textContent: "None." })];
  }

  function boardTab() {
    const rows = data.board.map((d) => {
      const b = el("button", { type: "button", className: "primary small", textContent: "Offer" });
      b.addEventListener("click", () => { view = { take: d, owner: d.owner }; render(); });
      return digimonRow(d, [b], `${d.speciesName}, ${d.owner.name}`);
    });
    return [el("p", { className: "hint", textContent: "Digimon other players want to trade. Put yours here with To board." }),
      rows.length ? el("ul", { className: "bank-list" }, ...rows) : el("p", { className: "empty", textContent: "The board is empty." })];
  }

  async function act(action, body, done) {
    try {
      await api(`/api/bank/${action}`, body);
      ctx.say(done, "ok");
      if (action === "withdraw") ctx.gifts.refresh();
      await refresh();
    } catch (err) { ctx.say(err.message, "error"); }
  }

  function render() {
    if (view?.farm) return root.replaceChildren(...farmView());
    if (view?.take) return root.replaceChildren(...offerView(view.take, view.owner));
    if (view) return root.replaceChildren(...playerView());
    const tabs = el("div", { className: "chips", role: "tablist" }, ...[["mine", "My bank"], ["offers", "Offers"], ["board", "Board"]]
      .map(([value, text]) => {
        const n = value === "offers" ? data.incoming.length : 0;
        const b = el("button", { type: "button", role: "tab", className: "chip", textContent: text },
          n ? el("span", { className: "badge", textContent: String(n) }) : null);
        b.setAttribute("aria-selected", String(value === tab));
        b.addEventListener("click", () => { tab = value; render(); });
        return b;
      }));
    const body = tab === "offers" ? offersTab() : tab === "board" ? boardTab() : mineTab();
    root.replaceChildren(tabs, ...body);
  }

  async function refresh() {
    try {
      if (!resumed) {
        resumed = true;
        if ((await api("/api/bank/resume", {})).again) ctx.gifts.refresh();
      }
      data = await api("/api/bank");
      ctx.badge("bank", data.incoming.length);
      if (!view) render();
    } catch { /* offline: try again later */ }
  }

  render();
  return { refresh, stored, opened: () => { view = null; render(); } };
}
