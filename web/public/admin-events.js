// The events editor (web/events.js): create and edit events, follow their standings, end or
// cancel them. The play page shows them in its Events tab (public/events.js).
import { api, digimonSprite, el, fromLocalInput, localInput, localTime, num, setStatus, updated } from "./admin-common.js";

const $ = (id) => document.getElementById(id);
const LEVELS = ["Baby I", "Baby II", "Rookie", "Champion", "Ultimate", "Mega"];
const KINDS = { battle: "Battle", contest: "Contest", collect: "Collection" };
const HINTS = {
  battle: "Most online wins between the start and the end takes first place.",
  contest: "Players hand over one Digimon from their bank; the best one in the chosen stat wins.",
  collect: "Players hand over Digimon from their bank; the most Digimon wins.",
};
const PHASES = { upcoming: "Upcoming", running: "Running", ended: "Ended" };
const STATUS = { open: null, paid: "Paid", cancelled: "Cancelled" };
const place = (n) => ["1st", "2nd", "3rd"][n - 1] ?? `${n}th`;

let kind = "battle", editing = null, info = null;

function setKind(value) {
  kind = value;
  for (const b of $("event-kind").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.kind === kind));
  $("kind-hint").textContent = HINTS[kind];
  $("ev-rules").hidden = kind === "battle";
  $("ev-stat-field").hidden = kind !== "contest";
}

function fillSelects() {
  $("ev-stat").replaceChildren(...info.statLabels.map((label, k) => el("option", { value: String(k + 2), textContent: label })),
    el("option", { value: "total", textContent: "Total of the six stats" }));
  $("ev-level").replaceChildren(el("option", { value: "", textContent: "Any level" }),
    ...LEVELS.map((l) => el("option", { value: l, textContent: l })));
  const species = [...info.species].sort((a, b) => a.name.localeCompare(b.name));
  $("ev-species").replaceChildren(el("option", { value: "", textContent: "Any Digimon" }),
    ...species.map((s) => el("option", { value: String(s.id), textContent: `${s.name} (${s.level})` })));
}

function resetForm() {
  editing = null;
  $("event-form").reset();
  setKind("battle");
  const start = new Date(Date.now() + 10 * 60_000), end = new Date(start.getTime() + 7 * 86_400_000);
  const asInput = (d) => localInput(d.toISOString().slice(0, 19).replace("T", " "));
  $("ev-start").value = asInput(start);
  $("ev-end").value = asInput(end);
  $("form-title").textContent = "New event";
  $("ev-save").textContent = "Create the event";
  $("ev-new").hidden = true;
}

function edit(ev) {
  editing = ev.id;
  setKind(ev.kind);
  $("ev-title").value = ev.title;
  $("ev-body").value = ev.body;
  $("ev-start").value = localInput(ev.startsAt);
  $("ev-end").value = localInput(ev.endsAt);
  $("ev-stat").value = String(ev.rules.stat ?? 2);
  $("ev-level").value = ev.rules.level ?? "";
  $("ev-species").value = ev.rules.species ? String(ev.rules.species) : "";
  $("ev-rewards").value = ev.rewards.join(", ");
  $("form-title").textContent = `Edit: ${ev.title}`;
  $("ev-save").textContent = "Save the changes";
  $("ev-new").hidden = false;
  $("ev-title").focus();
}

function readForm() {
  const rewards = $("ev-rewards").value.split(/[\s,;]+/).filter(Boolean).map((v) => Math.trunc(Number(v)));
  const stat = $("ev-stat").value;
  return {
    id: editing ?? undefined, kind, title: $("ev-title").value, body: $("ev-body").value,
    startsAt: fromLocalInput($("ev-start").value), endsAt: fromLocalInput($("ev-end").value), rewards,
    rules: { stat: stat === "total" ? "total" : Number(stat), level: $("ev-level").value || undefined,
      species: $("ev-species").value ? Number($("ev-species").value) : undefined },
  };
}

function scoreText(ev, score) {
  if (ev.kind === "battle") return `${num(score)} win${score === 1 ? "" : "s"}`;
  if (ev.kind === "collect") return `${num(score)} Digimon`;
  return num(score);
}

function action(label, path, ev, confirmText) {
  const b = el("button", { type: "button", className: "pill", textContent: label });
  let armed = false;
  b.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmText;
      setTimeout(() => { armed = false; b.textContent = label; }, 4000);
      return;
    }
    try {
      await api(`events/${path}`, { id: ev.id });
      await load();
      setStatus(`${ev.title}: done.`, "done");
    } catch (err) { setStatus(err.message, "err"); }
  });
  return b;
}

function card(ev) {
  const rules = ev.kind === "battle" ? "Online wins"
    : [ev.kind === "contest" ? `Ranked by ${ev.rules.statName}` : "Most Digimon",
      ev.rules.level, ev.rules.speciesName].filter(Boolean).join(", ");
  const rewards = ev.rewards.map((c, k) => (c ? `${place(k + 1)} ${num(c)}` : null)).filter(Boolean).join(", ");
  const state = STATUS[ev.status] ?? PHASES[ev.phase];
  const tag = el("span", { className: "tag", textContent: state });
  tag.dataset.status = ev.status === "open" && ev.phase === "running" ? "pending" : ev.status === "paid" ? "delivered" : "";
  const buttons = [];
  if (ev.status === "open") {
    const editB = el("button", { type: "button", className: "pill", textContent: "Edit" });
    editB.addEventListener("click", () => edit(ev));
    buttons.push(editB);
    if (ev.phase === "running") buttons.push(action("End now and pay", "end", ev, "Sure? Pays now"));
    buttons.push(action("Cancel", "cancel", ev, "Sure? No coins"));
  }
  const standings = ev.top.length
    ? el("ol", { className: "admin-standings" }, ...ev.top.map((r) => el("li", {},
      el("span", { className: "place", textContent: place(r.place) }),
      el("a", { href: `/admin/player?id=${r.userId}`, textContent: r.name }),
      el("span", { textContent: scoreText(ev, r.score) }),
      el("span", { className: "coins-won", textContent: r.coins ? `${num(r.coins)} coins` : "" }))))
    : el("p", { className: "hint", textContent: "Nobody yet." });
  const entries = ev.entries?.length
    ? el("details", { className: "entries" }, el("summary", { textContent: `${ev.entries.length} Digimon handed over` }),
      el("div", { className: "entry-grid" }, ...ev.entries.map((e) => el("span", { className: "entry", title: e.player },
        digimonSprite(e.species, 32, ""), el("span", { textContent: `${e.name} (${e.player})` })))))
    : null;
  return el("article", { className: `event-edit${ev.status === "cancelled" ? " off" : ""}` },
    el("div", { className: "offer-edit-head" },
      el("span", { className: "tag kind", textContent: KINDS[ev.kind] }),
      el("div", {}, el("b", { textContent: ev.title }),
        el("p", { textContent: `${localTime(ev.startsAt)} to ${localTime(ev.endsAt)}. ${rules}.${rewards ? ` Coins: ${rewards}.` : ""}` })),
      tag),
    ev.body ? el("p", { className: "event-text", textContent: ev.body }) : null,
    standings, entries,
    buttons.length ? el("div", { className: "actions" }, ...buttons) : null);
}

async function load() {
  setStatus("Loading...");
  info = await api("events");
  $("event-count").textContent = `${info.events.length} event${info.events.length === 1 ? "" : "s"}`;
  $("events").replaceChildren(...(info.events.length ? info.events.map(card)
    : [el("p", { className: "empty", textContent: "No event yet. Create one on the right." })]));
  updated();
}

$("event-kind").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]");
  if (b) setKind(b.dataset.kind);
});
$("ev-new").addEventListener("click", resetForm);
$("event-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("ev-save").disabled = true;
  try {
    const body = readForm();
    const { id } = await api("events/save", body);
    const text = editing ? "Event saved." : `Event #${id} created.`;
    resetForm();
    await load();
    setStatus(text, "done");
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    $("ev-save").disabled = false;
  }
});
$("admin-refresh").addEventListener("click", () => load().catch((err) => setStatus(err.message, "err")));

load().then(() => { fillSelects(); resetForm(); }).catch((err) => setStatus(err.message, "err"));
