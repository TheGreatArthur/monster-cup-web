// The shop tab of the play page's left panel (hub.js): the offers an admin put in the shop
// (web/shop.js, /admin/shop), by category, as a short list; a tap opens the offer with its sprite,
// its price and, for a Digimon, the stats it arrives with. A bought offer is queued as a gift: the
// gifts module (gifts.js) brings it through the game's mail, so the page asks it to look right away.
import { api, coinTag, confirmButton, digimonIcon, el, itemIcon, statTable, timeUntil } from "./hub.js";

const CATEGORIES = [["digimon", "Digimon"], ["item", "Items"]];

export function setupShop(root, ctx) {
  let offers = [], category = "digimon", open = null, winCoins = 5;

  const icon = (o, size) => (o.kind === "digimon" ? digimonIcon(o.value, size, o.name) : itemIcon(o.value, size, o.name));
  const label = (o) => (o.kind === "item" && o.qty > 1 ? `${o.qty} x ${o.name}` : o.name);

  function price(o, big = false) {
    return el("span", { className: `offer-price${big ? " big" : ""}` },
      o.discount ? el("s", { textContent: o.price.toLocaleString("en-US") }) : null,
      coinTag(o.cost),
      o.discount ? el("span", { className: "sale", textContent: `-${o.discount}%` }) : null);
  }

  function listView() {
    const chips = el("div", { className: "chips", role: "tablist" }, ...CATEGORIES.map(([value, text]) => {
      const n = offers.filter((o) => o.kind === value).length;
      const b = el("button", { type: "button", role: "tab", className: "chip", textContent: `${text} ${n}` });
      b.setAttribute("aria-selected", String(value === category));
      b.addEventListener("click", () => { category = value; render(); });
      return b;
    }));
    const list = offers.filter((o) => o.kind === category);
    const rows = el("ul", { className: "offer-list" }, ...list.map((o) => {
      const b = el("button", { type: "button", className: "offer-row" },
        el("span", { className: "offer-icon" }, icon(o, 32)),
        el("span", { className: "offer-name" }, el("b", { textContent: label(o) }),
          el("small", { textContent: o.soldOut ? "Sold out" : o.kind === "digimon" ? o.level : o.category })),
        price(o));
      if (o.soldOut) b.classList.add("sold-out");
      b.addEventListener("click", () => { open = o.id; render(); });
      return el("li", {}, b);
    }));
    return [
      el("p", { className: "hint", textContent: `Beat another player online to earn ${winCoins} coins.` }),
      chips,
      list.length ? rows : el("p", { className: "empty", textContent: "Nothing here yet. Come back soon!" }),
    ];
  }

  function detailView(o) {
    const back = el("button", { type: "button", className: "back", textContent: "All offers" });
    back.addEventListener("click", () => { open = null; render(); });
    const facts = o.kind === "digimon"
      ? [el("p", { className: "offer-kind", textContent: [o.level, o.attribute, ...o.types].filter(Boolean).join(" . ") }),
        el("h4", { textContent: o.bonus ? "Stats on arrival (trained)" : "Stats on arrival" }),
        statTable(o.stats, o.bonus)]
      : [el("p", { className: "offer-kind", textContent: `${o.category}${o.qty > 1 ? `, ${o.qty} per purchase` : ""}` })];
    const notes = [
      o.discount && o.saleEnds ? `Sale ends in ${timeUntil(o.saleEnds)}.` : null,
      o.stock !== null && !o.soldOut ? `${o.stock} left.` : null,
    ].filter(Boolean).join(" ");
    let buy;
    if (o.soldOut) buy = el("button", { type: "button", className: "primary", disabled: true, textContent: "Sold out" });
    else if (ctx.coins < o.cost) buy = el("button", { type: "button", className: "primary", disabled: true, textContent: `${o.cost - ctx.coins} more coins` });
    else buy = confirmButton("Buy", `Pay ${o.cost}`, () => purchase(o));
    return [back,
      el("div", { className: "offer-detail" },
        el("div", { className: "offer-art" }, icon(o, 96)),
        el("h3", { textContent: label(o) }),
        ...facts,
        notes ? el("p", { className: "hint", textContent: notes }) : null,
        el("div", { className: "offer-buy" }, price(o, true), buy))];
  }

  async function purchase(o) {
    try {
      const res = await api("/api/shop/buy", { id: o.id });
      ctx.setCoins(res.coins);
      ctx.say(`${res.name} is yours! It arrives by mail in the game: open your mail on the farm.`, "ok");
      ctx.gifts.refresh();
      await refresh();
    } catch (err) {
      if (err.data?.coins !== undefined) ctx.setCoins(err.data.coins);
      ctx.say(err.message, "error");
      await refresh();
    }
  }

  function render() {
    const o = open !== null && offers.find((x) => x.id === open);
    if (open !== null && !o) open = null;
    root.replaceChildren(...(o ? detailView(o) : listView()));
  }

  async function refresh() {
    try {
      const shop = await api("/api/shop");
      offers = shop.offers;
      winCoins = shop.winCoins;
      ctx.setCoins(shop.coins);
      render();
    } catch { /* offline: try again later */ }
  }

  ctx.onCoins = () => { if (open !== null) render(); };
  render();
  return { refresh };
}
