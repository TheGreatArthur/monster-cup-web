// The live players' page (web/admin.js, web/presence.js, web/save-info.js): every account, who is
// playing right now and what its save holds, refreshed every few seconds. An account opens on its
// own page (admin-player.html).
import { ago, api, digimonSprite, el, lastSeen, num, presenceBadge, setStatus, updated } from "./admin-common.js";

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 5_000, TEAM_SHOWN = 5;
const COLUMNS = ["Account", "Digimon", "Rank", "Bits", "Medals", "Elo", "Gifts", "Last save"];
let players = [], drawn = null;

const cell = (text, className = "") => el("span", { className, textContent: text });

function row(p) {
  const s = p.save, ok = s && !s.error;
  const team = ok ? s.team.slice(0, TEAM_SHOWN).map((id) => digimonSprite(id, 40, "")) : [];
  const tamer = ok ? `Tamer ${s.tamer}` : s ? "Unreadable save" : "No save yet";
  return el("a", { className: "player-row", href: `/admin/player?id=${p.id}` },
    el("span", { className: "player-name" }, el("b", { textContent: p.name }), presenceBadge(p)),
    el("span", { className: "team", title: tamer }, ...team, !team.length ? cell(tamer, "hint") : null),
    cell(ok ? s.rank : "", "wide-only gold"),
    cell(ok ? num(s.bits) : "", "wide-only num"),
    cell(ok ? String(s.cups) : "", "wide-only num"),
    cell(String(p.rating), "wide-only num"),
    cell(p.pending ? String(p.pending) : "", "wide-only num"),
    cell(s?.updated ? ago(s.updated) : "", "wide-only hint"));
}

function draw() {
  const q = $("player-search").value.trim().toLowerCase();
  const shown = players.filter((p) => p.name.toLowerCase().includes(q) || p.save?.tamer?.toLowerCase().includes(q));
  // Redrawn only when something changed, so a refresh never disturbs the pointer.
  const key = JSON.stringify([q, shown]);
  if (key === drawn) return;
  drawn = key;
  const head = el("div", { className: "player-row head", role: "presentation" },
    ...COLUMNS.map((c, k) => cell(c, k > 1 ? "wide-only" : "")));
  $("players").replaceChildren(head, ...(shown.length ? shown.map(row)
    : [el("p", { className: "empty", textContent: q ? "No account matches this search." : "No accounts yet." })]));
}

async function load() {
  ({ players } = await api("players"));
  // Online players first, then the most recently seen.
  players.sort((a, b) => b.presence.online - a.presence.online
    || (lastSeen(b) ?? "").localeCompare(lastSeen(a) ?? "") || a.id - b.id);
  const n = players.filter((p) => p.presence.online).length;
  $("online-count").textContent = `${n} playing now, ${players.length} accounts. Open an account to see its whole save and send it a gift.`;
  draw();
  updated();
}

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try { await load(); } catch (err) { setStatus(err.message, "err"); } finally { busy = false; }
}

$("player-search").addEventListener("input", draw);
refresh();
setInterval(refresh, REFRESH_MS);
