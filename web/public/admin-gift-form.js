// The gift composer of the admin pages (admin-player.html, admin-gifts.html): pick a Digimon and
// edit its bonus stats, an amount of bits, an item or one of the game's mails, each with its sprite.
import { api, digimonSprite, el, itemSprite, num, setStatus } from "./admin-common.js";

const LEVELS = ["All", "Baby I", "Baby II", "Rookie", "Champion", "Ultimate", "Mega"];
const CATEGORIES = ["All", "Care", "Hunting", "Tools", "Cages"];
const BITS_CHIPS = [1000, 10_000, 100_000, 1_000_000];
const KINDS = [["digimon", "Digimon"], ["bits", "Bits"], ["item", "Item"], ["mail", "Game mail"]];
export const STATUS = { pending: "Pending", delivered: "Delivered", cancelled: "Cancelled" };

function segmented(labels, selected, onPick, className = "") {
  const buttons = labels.map(([value, label]) => {
    const b = el("button", { type: "button", role: "tab", textContent: label });
    b.setAttribute("aria-selected", String(value === selected));
    b.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-selected", String(other === b));
      onPick(value);
    });
    return b;
  });
  return el("div", { className: `tabs ${className}`, role: "tablist" }, ...buttons);
}
const asTabs = (list) => list.map((v) => [v, v]);

// The picture of a gift in the history.
export function giftIcon(g) {
  if (g.kind === "digimon") return digimonSprite(g.value, 40);
  if (g.kind === "item") return itemSprite(g.value, 40);
  return "";
}

export function giftText(g, options) {
  if (g.kind === "bits") return `${num(g.value)} bits`;
  if (g.kind === "item") return `${options.items[g.value]?.name ?? g.value} x${g.qty}`;
  if (g.kind === "digimon") return options.species.find((s) => s.id === g.value)?.name ?? `#${g.value}`;
  const mail = options.mails.find((m) => m.id === g.value);
  return mail ? `Game mail ${mail.id} (${mail.sender}), ${mail.gift}` : `Game mail ${g.value}`;
}

// The bonus of a Digimon gift, as "+50 HP, +10 Attack".
export function bonusText(g, options) {
  if (!g.bonus) return "";
  return g.bonus.map((b, k) => (b ? `+${num(b)} ${options.statLabels[k]}` : "")).filter(Boolean).join(", ");
}

// A pending gift's cancel button, or nothing.
export function cancelButton(g, onDone) {
  if (g.status !== "pending") return null;
  const button = el("button", { type: "button", className: "pill", textContent: "Cancel" });
  button.addEventListener("click", () => api("gift-cancel", { gift: g.id }).then(onDone)
    .catch((err) => setStatus(err.message, "err")));
  return button;
}

// One gift of a history list. player: a link to the account, on the page that lists them all.
export function giftRow(g, options, onDone, player = null) {
  const details = [bonusText(g, options), g.note, `${g.admin ?? "admin"}, ${g.created} UTC`].filter(Boolean).join(". ");
  const tag = el("span", { className: "tag", textContent: STATUS[g.status] ?? g.status });
  tag.dataset.status = g.status;
  return el("div", { className: "gift-row" },
    el("span", { className: "gift-icon" }, giftIcon(g)),
    el("div", {}, el("b", { textContent: giftText(g, options) }), player && " to ", player, el("p", { textContent: details })),
    el("div", { className: "gift-end" }, tag, cancelButton(g, onDone)));
}

// mount: the element to fill. target(): { id, name } of the player. onSent(): after a gift is queued.
// The shop editor (admin-shop.js) reuses it: kinds limits the tabs, extra adds its own fields,
// submit(gift) replaces the gift request and sendLabel() the button text.
export function mountGiftComposer(mount, options, { target, onSent, kinds = KINDS, extra = [], submit, sendLabel }) {
  const state = { kind: kinds[0][0], species: options.species.find((s) => s.name === "Agumon") ?? options.species[0],
    level: "All", digimonQuery: "", bonus: options.statLabels.map(() => 0),
    bits: 10_000, item: options.items[0], category: "All", itemQuery: "", qty: 1, mail: options.mails[0]?.id };
  const view = el("div", { className: "composer-view" });
  const note = el("input", { className: "input", maxLength: 200, id: "gift-note" });
  const send = el("button", { type: "submit", className: "pill primary wide", id: "gift-send" });

  function refreshSend() {
    if (sendLabel) {
      send.disabled = false;
      send.textContent = sendLabel();
      return;
    }
    const name = target()?.name;
    send.disabled = !name;
    send.textContent = name ? `Send to ${name}` : "Choose a player";
  }

  // --- Digimon -------------------------------------------------------------------------------

  function digimonEditor() {
    const s = state.species, totals = [];
    const redraw = () => s.base.forEach((base, k) => {
      totals[k].textContent = num(Math.min(base + state.bonus[k], options.maxBonus[k]));
    });
    const rows = options.statLabels.flatMap((label, k) => {
      const input = el("input", { type: "number", min: 0, max: options.maxBonus[k] - s.base[k], step: 1,
        value: state.bonus[k] || "", placeholder: "0" });
      input.setAttribute("aria-label", `${label} bonus`);
      input.addEventListener("input", () => {
        const max = options.maxBonus[k] - s.base[k];
        state.bonus[k] = Math.max(0, Math.min(Math.trunc(Number(input.value)) || 0, max));
        if (Number(input.value) !== state.bonus[k] && input.value !== "") input.value = state.bonus[k];
        redraw();
      });
      totals[k] = el("span", { className: "right total" });
      return [el("span", { textContent: label }), el("span", { className: "right", textContent: num(s.base[k]) }), input, totals[k]];
    });
    redraw();
    const reset = el("button", { type: "button", className: "pill", textContent: "Clear bonus" });
    reset.addEventListener("click", () => {
      state.bonus = options.statLabels.map(() => 0);
      render();
    });
    return el("div", { className: "editor" },
      el("div", { className: "editor-head" },
        el("div", { className: "editor-art" }, digimonSprite(s.id, 84, s.name)),
        el("div", {},
          el("h3", { textContent: s.name }),
          el("p", { textContent: [s.level, s.attribute, ...s.types].filter(Boolean).join(", ") }))),
      el("div", { className: "bonus-table" },
        el("span", { className: "th", textContent: "Stat" }), el("span", { className: "th right", textContent: "Base" }),
        el("span", { className: "th right", textContent: "Bonus" }), el("span", { className: "th right", textContent: "Total" }),
        ...rows),
      el("div", { className: "editor-foot" },
        el("span", { textContent: "The game can add a small random extra to the base." }), reset));
  }

  function digimonView() {
    const list = options.species.filter((s) => (state.level === "All" || s.level === state.level)
      && s.name.toLowerCase().includes(state.digimonQuery.toLowerCase()));
    const picker = el("div", { className: "picker" }, ...list.map((s) => {
      const b = el("button", { type: "button", className: "pick", title: s.name },
        digimonSprite(s.id, 50, ""), el("span", { textContent: s.name }));
      b.setAttribute("aria-pressed", String(s.id === state.species.id));
      b.addEventListener("click", () => { state.species = s; state.bonus = options.statLabels.map(() => 0); render(); });
      return b;
    }));
    if (!list.length) picker.append(el("p", { className: "empty", textContent: "No Digimon with this name." }));
    return [searchField("Search a Digimon", state.digimonQuery, (q) => { state.digimonQuery = q; }),
      segmented(asTabs(LEVELS), state.level, (level) => { state.level = level; render(); }, "level-tabs"),
      picker, digimonEditor()];
  }

  // Search keeps its focus: the list under it is redrawn, not the field.
  function searchField(placeholder, value, onChange) {
    const input = el("input", { className: "input", type: "search", placeholder, value });
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("input", () => {
      onChange(input.value);
      const at = input.selectionStart;
      render();
      const again = view.querySelector("input[type=search]");
      again.focus();
      again.setSelectionRange(at, at);
    });
    return input;
  }

  // --- bits ----------------------------------------------------------------------------------

  function bitsView() {
    const preview = el("div", { className: "bits-preview" });
    const input = el("input", { type: "number", min: 1, max: options.maxBits, value: state.bits, id: "gift-bits" });
    const show = () => { preview.textContent = `${num(state.bits)} bits`; };
    input.addEventListener("input", () => { state.bits = Math.trunc(Number(input.value)) || 0; show(); });
    show();
    const chips = BITS_CHIPS.map((n) => {
      const b = el("button", { type: "button", className: "pill", textContent: num(n) });
      b.addEventListener("click", () => { state.bits = n; input.value = n; show(); });
      return b;
    });
    return [preview, el("label", { className: "field" }, "Amount", input), el("div", { className: "chips" }, ...chips)];
  }

  // --- items ---------------------------------------------------------------------------------

  function itemView() {
    const i = state.item;
    const list = options.items.filter((it) => (state.category === "All" || it.category === state.category)
      && it.name.toLowerCase().includes(state.itemQuery.toLowerCase()));
    const picker = el("div", { className: "picker" }, ...list.map((it) => {
      const b = el("button", { type: "button", className: "pick", title: it.name },
        itemSprite(it.id, 50, ""), el("span", { textContent: it.name }));
      b.setAttribute("aria-pressed", String(it.id === i.id));
      b.addEventListener("click", () => { state.item = it; state.qty = 1; render(); });
      return b;
    }));
    if (!list.length) picker.append(el("p", { className: "empty", textContent: "No item with this name." }));
    const qty = el("input", { type: "number", min: 1, max: 99, value: state.qty, id: "gift-qty" });
    qty.setAttribute("aria-label", "Quantity");
    qty.addEventListener("input", () => { state.qty = Math.trunc(Number(qty.value)) || 1; });
    return [searchField("Search an item", state.itemQuery, (q) => { state.itemQuery = q; }),
      segmented(asTabs(CATEGORIES), state.category, (category) => { state.category = category; render(); }, "level-tabs"),
      picker,
      el("div", { className: "selected-item" }, itemSprite(i.id, 48, ""),
        el("div", {}, el("h3", { textContent: i.name }), el("p", { textContent: `${i.category}, shop price ${num(i.price)} bits` })),
        el("label", { className: "field" }, "Quantity", qty))];
  }

  // --- game mails ----------------------------------------------------------------------------

  function mailView() {
    const select = el("select", { id: "gift-mail" }, ...options.mails.map((m) => el("option", { value: m.id,
      textContent: `${m.id}: ${m.sender}, ${m.gift}` })));
    select.value = state.mail;
    select.addEventListener("change", () => { state.mail = Number(select.value); });
    return [el("p", { className: "hint", textContent: "One of the game's own gift mails, with its original sender and text." }),
      el("label", { className: "field" }, "Mail", select)];
  }

  function render() {
    const views = { digimon: digimonView, bits: bitsView, item: itemView, mail: mailView };
    view.replaceChildren(...views[state.kind]());
    refreshSend();
  }

  function gift() {
    if (state.kind === "bits") return { kind: "bits", value: state.bits };
    if (state.kind === "item") return { kind: "item", value: state.item.id, qty: state.qty };
    if (state.kind === "mail") return { kind: "mail", value: state.mail };
    return { kind: "digimon", value: state.species.id, bonus: state.bonus };
  }

  const form = el("form", { className: "composer", id: "gift-form" },
    segmented(kinds, state.kind, (kind) => { state.kind = kind; render(); }),
    view,
    ...extra,
    submit ? null : el("label", { className: "field" }, "Note for the history (optional)", note),
    send);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    send.disabled = true;
    if (submit) {
      try { await submit(gift()); } finally { refreshSend(); }
      return;
    }
    const { id, name } = target();
    try {
      const res = await api("gift", { user: id, ...gift(), note: note.value });
      setStatus(`Gift #${res.id} sent to ${name}.`, "done");
      note.value = "";
      await onSent();
    } catch (err) {
      setStatus(err.message, "err");
    } finally {
      refreshSend();
    }
  });
  mount.replaceChildren(form);
  render();
  return { refreshTarget: refreshSend };
}
