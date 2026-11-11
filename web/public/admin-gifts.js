// The gifts page (web/admin.js, web/gifts.js): queue a gift for any player, see what was sent.
import { api, el, playerLink, setStatus, updated } from "./admin-common.js";
import { giftRow, mountGiftComposer } from "./admin-gift-form.js";

const $ = (id) => document.getElementById(id);
let options, composer;

async function loadHistory() {
  const { gifts } = await api("gifts");
  $("gifts").replaceChildren(...(gifts.length
    ? gifts.map((g) => giftRow(g, options, loadHistory, playerLink(g.player_id, g.player)))
    : [el("p", { className: "empty", textContent: "No gift sent yet." })]));
}

async function loadPlayers() {
  const { players } = await api("players");
  const wanted = $("gift-user").value || new URLSearchParams(location.search).get("user");
  $("gift-user").replaceChildren(...players.map((p) => el("option", { value: p.id, textContent: p.name })));
  if (wanted) $("gift-user").value = wanted;
}

async function load() {
  setStatus("Loading...");
  await Promise.all([loadPlayers(), loadHistory()]);
  composer?.refreshTarget();
  updated();
}

async function start() {
  options = await api("gift-options");
  await load();
  composer = mountGiftComposer($("composer"), options, {
    target: () => {
      const chosen = $("gift-user").selectedOptions[0];
      return chosen && { id: Number(chosen.value), name: chosen.textContent };
    },
    onSent: loadHistory,
  });
  $("gift-user").addEventListener("change", () => composer.refreshTarget());
}

$("admin-refresh").addEventListener("click", () => load().catch((err) => setStatus(err.message, "err")));
start().catch((err) => setStatus(err.message, "err"));
