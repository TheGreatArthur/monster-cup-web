// The shop editor (web/shop.js): the offers players buy with PvP coins. Each row edits its price,
// sale, stock, order and visibility in place; the composer on the right adds a Digimon (with bonus
// stats) or an item.
import { api, digimonSprite, el, fromLocalInput, itemSprite, localInput, num, setStatus, updated } from "./admin-common.js";
import { bonusText, mountGiftComposer } from "./admin-gift-form.js";

const $ = (id) => document.getElementById(id);
let options;

const int = (input) => (input.value === "" ? null : Math.trunc(Number(input.value)));
const numberInput = (value, min, max, label, placeholder = "") => {
  const input = el("input", { type: "number", min, max, step: 1, value: value ?? "", placeholder });
  input.setAttribute("aria-label", label);
  return input;
};
const field = (label, input) => el("label", { className: "field" }, label, input);

// The price fields shared by a catalogue row and the composer.
function priceFields(o = {}) {
  const f = {
    price: numberInput(o.price ?? 100, 0, 1_000_000, "Price"),
    discount: numberInput(o.discountSet || "", 0, 100, "Discount", "0"),
    saleEnds: el("input", { type: "datetime-local", value: localInput(o.saleEndsSet) }),
    stock: numberInput(o.stock, 0, 1_000_000, "Stock", "No limit"),
    sort: numberInput(o.sort || "", 0, 9999, "Order", "0"),
  };
  f.saleEnds.setAttribute("aria-label", "Sale ends");
  f.read = () => ({ price: int(f.price) ?? 0, discount: int(f.discount) ?? 0, saleEnds: fromLocalInput(f.saleEnds.value),
    stock: int(f.stock), sort: int(f.sort) ?? 0 });
  f.nodes = [field("Price (coins)", f.price), field("Sale %", f.discount), field("Sale ends (empty: no end)", f.saleEnds),
    field("Stock (empty: no limit)", f.stock), field("Order (small first)", f.sort)];
  return f;
}

function offerRow(o) {
  const f = priceFields(o);
  const active = el("input", { type: "checkbox", checked: o.active });
  const save = el("button", { type: "button", className: "pill primary", textContent: "Save" });
  const del = el("button", { type: "button", className: "pill", textContent: "Delete" });
  save.addEventListener("click", async () => {
    try {
      await api("shop/save", { id: o.id, kind: o.kind, value: o.value, qty: o.qty, bonus: o.bonus, ...f.read(),
        active: active.checked });
      await load();
      setStatus(`${o.name} saved.`, "done");
    } catch (err) { setStatus(err.message, "err"); }
  });
  let armed = false;
  del.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      del.textContent = "Sure?";
      setTimeout(() => { armed = false; del.textContent = "Delete"; }, 4000);
      return;
    }
    try {
      await api("shop/delete", { id: o.id });
      await load();
      setStatus(`${o.name} removed from the shop.`, "done");
    } catch (err) { setStatus(err.message, "err"); }
  });
  const title = o.kind === "item" && o.qty > 1 ? `${o.qty} x ${o.name}` : o.name;
  const facts = [
    o.kind === "digimon" ? [o.level, bonusText(o, options)].filter(Boolean).join(", ") : o.category,
    o.discount ? `now ${num(o.cost)} coins (-${o.discount}%)` : null,
    `${num(o.sold)} sold`,
    o.soldOut ? "sold out" : null,
  ].filter(Boolean).join(". ");
  const row = el("article", { className: `offer-edit${o.active ? "" : " off"}` },
    el("div", { className: "offer-edit-head" },
      el("span", { className: "gift-icon" }, o.kind === "digimon" ? digimonSprite(o.value, 40) : itemSprite(o.value, 40)),
      el("div", {}, el("b", { textContent: title }), el("p", { textContent: facts })),
      el("label", { className: "switch" }, active, "In the shop")),
    el("div", { className: "offer-edit-fields" }, ...f.nodes),
    el("div", { className: "actions" }, save, del));
  return row;
}

async function load() {
  setStatus("Loading...");
  const { offers } = await api("shop");
  $("offer-count").textContent = `${offers.length} offer${offers.length === 1 ? "" : "s"}`;
  const groups = [["digimon", "Digimon"], ["item", "Items"]].map(([kind, label]) => {
    const list = offers.filter((o) => o.kind === kind);
    return list.length ? [el("h3", { className: "group-title", textContent: label }), ...list.map(offerRow)] : [];
  }).flat();
  $("offers").replaceChildren(...(groups.length ? groups
    : [el("p", { className: "empty", textContent: "The shop is empty. Add an offer on the right." })]));
  updated();
}

async function start() {
  options = await api("gift-options");
  await load();
  const f = priceFields();
  mountGiftComposer($("composer"), options, {
    target: () => null,
    kinds: [["digimon", "Digimon"], ["item", "Item"]],
    extra: [el("div", { className: "offer-edit-fields" }, ...f.nodes)],
    sendLabel: () => "Add to the shop",
    submit: async (gift) => {
      try {
        const { id } = await api("shop/save", { ...gift, ...f.read(), active: true });
        await load();
        setStatus(`Offer #${id} added to the shop.`, "done");
      } catch (err) { setStatus(err.message, "err"); }
    },
  });
}

$("admin-refresh").addEventListener("click", () => load().catch((err) => setStatus(err.message, "err")));
start().catch((err) => setStatus(err.message, "err"));
