// Helpers shared by the admin pages (admin.html, admin-players.html, admin-player.html, admin-gifts.html,
// admin-shop.html, admin-events.html).
const status = document.getElementById("admin-status");

export function setStatus(text, kind) {
  status.textContent = text;
  status.dataset.kind = kind ?? "";
}

export const updated = () => setStatus(`Updated at ${new Date().toLocaleTimeString("en-GB")}`, "ok");

export async function api(path, body) {
  const res = await fetch(`/api/admin/${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// el("div", { className: "x" }, child, "text"): a new element.
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== ""));
  return node;
}

export const num = (n) => (n ?? 0).toLocaleString("en-US");

// A game picture at the largest whole-number zoom that fits a square of box px, so its pixels stay
// sharp. CSS caps the few that are larger than their box.
export function sprite(src, box, alt = "") {
  const img = el("img", { src, alt, loading: "lazy" });
  img.addEventListener("load", () => {
    const zoom = Math.max(1, Math.floor(box / Math.max(img.naturalWidth, img.naturalHeight)));
    img.width = img.naturalWidth * zoom;
    img.height = img.naturalHeight * zoom;
  }, { once: true });
  return img;
}
export const digimonSprite = (species, box, alt) => sprite(`/game-assets/admin/digimon/${species}.png`, box, alt);
export const itemSprite = (item, box, alt) => sprite(`/game-assets/admin/items/${item}.png`, box, alt);
export const medalSprite = (cup, alt) => sprite(`/game-assets/admin/badges/${cup}.png`, 48, alt);

// A UTC "YYYY-MM-DD HH:MM:SS" as the local value of an <input type="datetime-local">, and back to ISO.
export function localInput(utc) {
  if (!utc) return "";
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);
// A UTC "YYYY-MM-DD HH:MM:SS" in the admin's local time, short.
export const localTime = (utc) => new Date(`${utc.replace(" ", "T")}Z`).toLocaleString("en-GB",
  { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// "3 min ago" from a UTC "YYYY-MM-DD HH:MM:SS".
export function ago(utc) {
  const s = Math.max(0, (Date.now() - Date.parse(`${utc.replace(" ", "T")}Z`)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const GIFT_PHASE = { queued: "gift ready, waiting for the farm", sent: "mail in the box, not opened yet",
  opened: "mail open", bonus: "adding bonus stats" };

// When the player last played: its last report, else its last save upload.
export const lastSeen = (p) => p.presence.seen ?? p.save?.updated ?? null;

// A player's presence, as a coloured line of text.
export function presenceBadge(p) {
  const { online, state } = p.presence, seen = lastSeen(p);
  let text, kind = "off";
  if (!online) {
    text = seen ? `Offline, seen ${ago(seen)}` : "Never played";
  } else {
    text = state.game === "running" ? "Playing" : "Loading the game";
    if (!state.visible) text += " (tab hidden)";
    if (state.gift) text += `: ${GIFT_PHASE[state.gift]}`;
    kind = state.game === "running" && state.visible ? "on" : "idle";
  }
  const span = el("span", { className: "presence", textContent: text });
  span.dataset.kind = kind;
  return span;
}

// A table from a header row and rows of cells (strings or nodes).
export function fill(table, head, rows, empty = "Nothing to report.") {
  table.replaceChildren();
  if (!rows.length) {
    table.insertRow().insertCell().append(el("p", { className: "empty", textContent: empty }));
    return;
  }
  const tr = table.insertRow();
  for (const h of head) tr.appendChild(el("th", { textContent: h }));
  for (const row of rows) {
    const r = table.insertRow();
    for (const cell of row) r.insertCell().append(cell ?? "");
  }
}

export const playerLink = (id, name) => el("a", { href: `/admin/player?id=${id}`, textContent: name });
