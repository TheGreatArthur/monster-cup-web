// One account in full (web/admin.js, web/save-info.js): its Digimon with sprites and stats, bits,
// rank, the cages placed on the farm, its medals, and the form that sends it a gift.
import { api, digimonSprite, el, itemSprite, medalSprite, num, presenceBadge, setStatus, updated } from "./admin-common.js";
import { giftRow, mountGiftComposer } from "./admin-gift-form.js";

const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const REFRESH_MS = 5_000;
// The farm's hex strip: even cells on the top row, odd cells half a cell lower right.
const HEX_W = 26, HEX_H = 30, STRIP_CELLS = 24;
const CAGE_COLOURS = ["#3fd2ff", "#ffc531", "#5fe3a1", "#ff8fb1", "#b79bff", "#ff9f5a", "#7ce1ff", "#d7e36b",
  "#6fb7ff", "#ffb8e0", "#8ef0d0", "#ffd98a", "#a0a8ff", "#e88fff", "#9fe870", "#ffa3a3"];
let options, player, shownSave = null, shownGifts = null, composer;

const fact = (value, label, className = "") => el("div", { className: `fact glass ${className}` },
  el("b", { className: className.includes("gold") ? "gold" : "", textContent: value }), el("span", { textContent: label }));

function heroSprite(save) {
  // The strongest Digimon stands for the account.
  const best = save && !save.error ? [...save.digimon].sort((a, b) => b.stats[0] - a.stats[0])[0] : null;
  return best ? digimonSprite(best.speciesId, 132, best.species) : "";
}

function drawHero() {
  const { save } = player;
  const ok = save && !save.error;
  $("hero").replaceChildren(
    el("div", { className: "hero-sprite" }, heroSprite(save)),
    el("div", {},
      el("h1", { textContent: player.name }),
      el("div", { className: "hero-meta" }, presenceBadge(player),
        ...[ok ? `Tamer ${save.tamer}` : "", `Elo ${player.rating} (${player.wins}-${player.losses})`,
          save?.updated ? `Save from ${save.updated} UTC` : ""].filter(Boolean).map((textContent) => el("span", { textContent })))));
}

function drawFacts(save) {
  const ladder = el("div", { className: "rank-ladder" }, ...save.ranks.map((name, r) => {
    const span = el("span", { textContent: name });
    if (r === save.rankIndex) span.className = "current";
    else if (r < save.rankIndex) span.className = "passed";
    return span;
  }));
  const d = save.date;
  $("facts").replaceChildren(
    fact(num(save.bits), "Bits", "gold"),
    fact(`${save.cups.length} / ${save.cupCount}`, "Medals"),
    fact(`${save.dex} / ${save.dexCount}`, "Digipedia"),
    el("div", { className: "fact glass wide" }, el("b", { className: "gold", textContent: save.rank }), el("span", { textContent: "Tamer rank" }), ladder),
    fact(save.playTime, "Play time"),
    fact(`Year ${d.year}, ${d.season} ${d.day}`, `In-game date, ${d.time}`),
    el("div", { className: "fact glass" }, el("span", { textContent: "Care items" }),
      el("div", { className: "care" }, ...save.consumables.map((c) => el("div", { title: c.name },
        itemSprite(c.id, 28, c.name), el("b", { className: "num", style: "font-size:15px", textContent: String(c.count) }))))));
}

function digimonCard(d, save) {
  const cage = save.cages.find((c) => c.index === d.cage);
  const labels = options.statLabels;
  const values = [`${num(d.hp)} / ${num(d.stats[0])}`, `${num(d.tp)} / ${num(d.stats[1])}`, ...d.stats.slice(2).map(num)];
  return el("article", { className: "digimon-card" },
    el("div", { className: "digimon-art" }, digimonSprite(d.speciesId, 96, d.species)),
    el("h3", { textContent: d.name || d.species }),
    el("p", { textContent: [d.name && d.name !== d.species ? d.species : "", d.level, d.attribute, ...d.types].filter(Boolean).join(", ")
      + (cage ? `. In ${cage.name}` : "") }),
    el("dl", { className: "stat-grid" }, ...labels.map((label, k) => el("div", {},
      el("dt", { textContent: label }), el("dd", { textContent: values[k] })))),
    el("p", { className: "ap-line" }, "AP ", ...options.apLabels.flatMap((label, k) => [`${k ? ", " : ""}${label} `,
      el("b", { textContent: String(d.ap[k]) })])));
}

function drawHexMap(save) {
  const svg = $("hexmap");
  const used = new Map();
  save.cages.forEach((c, k) => { for (const cell of c.cells) used.set(cell, k); });
  const count = Math.max(STRIP_CELLS, Math.max(...used.keys(), 0) + 2 & ~1);
  const stepY = HEX_H * 0.75;
  const width = ((count >> 1) + 0.5) * HEX_W + 4, height = HEX_H + stepY + 4;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const parts = [];
  for (let cell = 0; cell < count; cell++) {
    const x = 2 + HEX_W / 2 + (cell >> 1) * HEX_W + (cell & 1) * HEX_W / 2, y = 2 + HEX_H / 2 + (cell & 1) * stepY;
    const points = [[0, -HEX_H / 2], [HEX_W / 2, -HEX_H / 4], [HEX_W / 2, HEX_H / 4], [0, HEX_H / 2], [-HEX_W / 2, HEX_H / 4], [-HEX_W / 2, -HEX_H / 4]]
      .map(([dx, dy]) => `${x + dx},${y + dy}`).join(" ");
    const k = used.get(cell);
    parts.push(k === undefined ? `<polygon points="${points}"/>`
      : `<polygon class="used" points="${points}" style="fill:${CAGE_COLOURS[k]}66"/><text x="${x}" y="${y}">${k + 1}</text>`);
  }
  svg.innerHTML = parts.join("");
}

function cageCard(c, k, save) {
  const tag = el("span", { className: "cage-tag", textContent: String(k + 1), style: `background:${CAGE_COLOURS[k]}99` });
  const art = el("div", { className: `cage-art ${c.item === null ? "no-icon" : ""}` }, c.item === null ? "" : itemSprite(c.item, 72, ""), tag);
  const who = c.digimon.map((slot) => save.digimon.find((d) => d.slot === slot));
  return el("article", { className: "cage" }, art,
    el("div", {},
      el("h3", { textContent: c.name }),
      el("p", { textContent: `${who.length}${c.limit ? ` / ${c.limit}` : ""} Digimon, ${c.cells.length} cell${c.cells.length > 1 ? "s" : ""}. ${c.effect}` }),
      el("div", { className: "occupants" }, ...who.map((d) => {
        const img = digimonSprite(d.speciesId, 40, d.species);
        img.title = d.name || d.species;
        return img;
      }))));
}

function drawSave() {
  const { save } = player;
  const key = JSON.stringify(save);
  if (key === shownSave) return;
  shownSave = key;
  const ok = save && !save.error;
  for (const panel of ["digimon-panel", "cages-panel", "medals-panel"]) $(panel).hidden = !ok;
  if (!ok) {
    $("facts").replaceChildren(el("div", { className: "fact glass wide" },
      el("b", { textContent: save ? "Unreadable save" : "No save yet" }),
      el("span", { textContent: save?.error ?? "This account has not saved a game on the site." })));
    return;
  }
  drawFacts(save);
  $("digimon-count").textContent = `${save.digimon.length} of 16 slots`;
  $("digimon").replaceChildren(...save.digimon.map((d) => digimonCard(d, save)));
  $("cages-count").textContent = `${save.cages.length} placed`;
  drawHexMap(save);
  $("cages").replaceChildren(...save.cages.map((c, k) => cageCard(c, k, save)));
  $("medals-count").textContent = `${save.cups.length} of ${save.cupCount} won`;
  $("medals").replaceChildren(...save.medals.map((m) => el("div", { className: `medal ${m.won ? "won" : "locked"}`, title: m.won ? `Won: ${m.name}` : `Not won: ${m.name}` },
    medalSprite(m.id, m.name), el("span", { textContent: m.name }))));
}

function drawGifts() {
  const key = JSON.stringify(player.gifts);
  if (key === shownGifts) return;
  shownGifts = key;
  $("gifts").replaceChildren(...(player.gifts.length ? player.gifts.map((g) => giftRow(g, options, refresh))
    : [el("p", { className: "empty", textContent: "No gift sent to this account yet." })]));
}

async function load() {
  player = await api(`player?id=${id}`);
  document.title = `${player.name} - Digimon World Championship admin`;
  drawHero();
  drawSave();
  drawGifts();
  $("composer-title").textContent = `Send ${player.name} a gift`;
  $("gift-hint").textContent = player.presence.online
    ? "Playing now: the mail arrives within seconds, once at the farm."
    : "Offline: the gift waits for the next game, at the farm.";
  composer?.refreshTarget();
  updated();
}

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try { await load(); } catch (err) { setStatus(err.message, "err"); } finally { busy = false; }
}

async function start() {
  if (!Number.isInteger(id)) throw new Error("No account chosen.");
  options = await api("gift-options");
  await load();
  composer = mountGiftComposer($("composer"), options, { target: () => ({ id, name: player?.name }), onSent: refresh });
  setInterval(refresh, REFRESH_MS);
}

start().catch((err) => {
  setStatus(err.message, "err");
  $("hero").replaceChildren(el("p", { className: "empty", textContent: `${err.message} Go back to the players' list.` }));
});
