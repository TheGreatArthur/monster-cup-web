// The play page's left panel: tabs for the shop (shop.js), the events (events.js) and the Digimon
// bank (bank.js), the player's PvP coins, and the small helpers the three share.
import { setupShop } from "./shop.js";
import { setupEvents } from "./events.js";
import { setupBank } from "./bank.js";

export const STAT_LABELS = ["HP", "TP", "Attack", "Defense", "Wisdom", "Speed"];

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

// A game sprite (exported to game-assets/admin/, served behind the login), drawn pixel sharp.
export function sprite(src, size, alt = "") {
  const img = el("img", { src, alt, loading: "lazy", className: "sprite" });
  img.style.setProperty("--size", `${size}px`);
  img.addEventListener("error", () => { img.style.visibility = "hidden"; }, { once: true });
  return img;
}
export const digimonIcon = (species, size = 32, alt = "") => sprite(`/game-assets/admin/digimon/${species}.png`, size, alt);
export const itemIcon = (item, size = 32, alt = "") => sprite(`/game-assets/admin/items/${item}.png`, size, alt);
export const coinTag = (amount, className = "") => el("span", { className: `price ${className}` },
  el("span", { className: "coin", ariaHidden: "true" }), el("span", { textContent: amount.toLocaleString("en-US") }));

// The stats of a Digimon: [max HP, max TP, Atk, Def, Wis, Spd], with the bonus part shown apart.
export function statTable(stats, bonus = null) {
  return el("dl", { className: "stat-table" }, ...STAT_LABELS.flatMap((label, k) => [
    el("dt", { textContent: label }),
    el("dd", {}, stats[k].toLocaleString("en-US"), bonus?.[k] ? el("small", { textContent: ` +${bonus[k]}` }) : null),
  ]));
}
// A banked Digimon's 8 saved stats ([HP, TP, max HP, max TP, Atk, Def, Wis, Spd]) as statTable wants them.
export const savedStats = (stats) => stats.slice(2);

// "2d 4h", "35 min": the time until a UTC "YYYY-MM-DD HH:MM:SS".
export function timeUntil(utc) {
  const ms = new Date(utc.replace(" ", "T") + "Z").getTime() - Date.now();
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ${min % 60 ? `${min % 60}min` : ""}`.trim() : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? "Something went wrong."), { data });
  return data;
}

// A button that asks once more before acting: the first press shows `confirm`, the second acts.
export function confirmButton(label, confirm, action, className = "primary") {
  const b = el("button", { type: "button", className, textContent: label });
  let armed = false, timer = 0;
  const reset = () => { armed = false; b.textContent = label; b.classList.remove("confirm"); };
  b.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      b.textContent = confirm;
      b.classList.add("confirm");
      clearTimeout(timer);
      timer = setTimeout(reset, 4000);
      return;
    }
    clearTimeout(timer);
    reset();
    b.disabled = true;
    try { await action(); } finally { b.disabled = false; }
  });
  return b;
}

export function setupHub({ gifts, syncSave }) {
  const hub = document.getElementById("hub");
  const balance = document.getElementById("coin-balance");
  const status = document.getElementById("hub-status");
  const tabs = [...hub.querySelectorAll("[data-hub]")];
  let coins = null;

  const ctx = {
    gifts, syncSave,
    get coins() { return coins ?? 0; },
    setCoins(value) {
      if (value === coins) return;
      const gained = coins !== null && value > coins;
      coins = value;
      balance.textContent = value.toLocaleString("en-US");
      if (gained) {
        balance.parentElement.classList.remove("gain");
        void balance.parentElement.offsetWidth;   // restart the animation
        balance.parentElement.classList.add("gain");
      }
      ctx.onCoins?.();
    },
    say(text, kind = "") {
      status.textContent = text;
      status.className = `hub-status ${kind}`;
    },
    badge(tab, n) {
      const b = hub.querySelector(`[data-hub="${tab}"] .badge`);
      b.hidden = !n;
      b.textContent = String(n);
    },
    show(tab) {
      for (const t of tabs) {
        const on = t.dataset.hub === tab;
        t.setAttribute("aria-selected", String(on));
        hub.querySelector(`[data-hub-panel="${t.dataset.hub}"]`).hidden = !on;
      }
      ctx.say("");
      ctx.panels[tab]?.opened?.();
    },
    panels: {},
  };
  for (const t of tabs) t.addEventListener("click", () => ctx.show(t.dataset.hub));

  ctx.panels.shop = setupShop(document.getElementById("shop"), ctx);
  ctx.panels.bank = setupBank(document.getElementById("bank"), ctx);
  ctx.panels.events = setupEvents(document.getElementById("events"), ctx);

  // A win paid PvP coins (online.js relays the server's event).
  window.addEventListener("dwc-coins", (e) => ctx.setCoins(e.detail));
  const refresh = () => {
    if (document.visibilityState !== "visible") return;
    for (const p of Object.values(ctx.panels)) p.refresh?.();
  };
  window.addEventListener("focus", refresh);
  setInterval(refresh, 30_000);
  refresh();
  return ctx;
}
