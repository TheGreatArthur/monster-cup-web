// The events tab of the play page's left panel (hub.js): the events the admins run (web/events.js),
// running first, with their rules, rewards and standings. In a contest or a collection the player
// hands over a Digimon from their bank (bank.js): it leaves the bank for good.
import { api, coinTag, confirmButton, digimonIcon, el, savedStats, statTable, timeUntil } from "./hub.js";

const KINDS = { battle: "Battle", contest: "Contest", collect: "Collection" };
const ORDER = { running: 0, upcoming: 1, ended: 2 };
const PLACES = ["1st", "2nd", "3rd"];
const place = (n) => PLACES[n - 1] ?? `${n}th`;

export function setupEvents(root, ctx) {
  let events = [], picking = null;

  function what(ev) {
    if (ev.kind === "battle") return "Win online battles against other players. Most wins takes first place.";
    const only = [ev.rules.level, ev.rules.speciesName].filter(Boolean).join(" ");
    if (ev.kind === "contest") {
      return `Hand over your best ${only || "Digimon"}: ranked by ${ev.rules.statName ?? "its stats"}. One Digimon per player.`;
    }
    return `Hand over as many ${only ? `${only} ` : ""}Digimon as you can.`;
  }

  function when(ev) {
    if (ev.phase === "upcoming") return `Starts in ${timeUntil(ev.startsAt)}`;
    if (ev.phase === "running") return `Ends in ${timeUntil(ev.endsAt)}`;
    return "Ended";
  }

  const scoreText = (ev, score) => (ev.kind === "battle" ? `${score} win${score === 1 ? "" : "s"}`
    : ev.kind === "collect" ? `${score} Digimon` : score.toLocaleString("en-US"));

  // The stored Digimon of the bank that fit the event's rules.
  function candidates(ev) {
    return ctx.panels.bank.stored().filter((d) => (!ev.rules.level || d.level === ev.rules.level)
      && (!ev.rules.species || d.species === ev.rules.species));
  }

  function picker(ev) {
    const list = candidates(ev);
    const cancel = el("button", { type: "button", className: "ghost small", textContent: "Cancel" });
    cancel.addEventListener("click", () => { picking = null; render(); });
    if (!list.length) {
      return el("div", { className: "event-pick" },
        el("p", { className: "hint", textContent: "No Digimon in your bank fits. Deposit one from your farm in the Bank tab first." }),
        cancel);
    }
    return el("div", { className: "event-pick" },
      el("p", { className: "hint", textContent: "It leaves your bank for good." }),
      el("ul", { className: "pick-list" }, ...list.map((d) => el("li", {},
        el("span", { className: "offer-icon" }, digimonIcon(d.species, 32, d.speciesName)),
        el("span", { className: "offer-name" }, el("b", { textContent: d.name }),
          el("small", { textContent: ev.kind === "contest" ? `${ev.rules.statName}: ${score(ev, d)}` : d.speciesName })),
        confirmButton("Give", "Sure?", () => enter(ev, d), "primary small")))),
      cancel);
  }

  const score = (ev, d) => (ev.rules.stat === "total" ? savedStats(d.stats).reduce((a, b) => a + b, 0) : d.stats[ev.rules.stat]);

  async function enter(ev, d) {
    try {
      await api("/api/events/enter", { event: ev.id, bank: d.id });
      ctx.say(`${d.name} entered ${ev.title}.`, "ok");
      picking = null;
      await Promise.all([refresh(), ctx.panels.bank.refresh()]);
    } catch (err) {
      ctx.say(err.message, "error");
    }
  }

  function card(ev) {
    const rewards = ev.rewards.map((c, k) => (c ? `${place(k + 1)} ${c.toLocaleString("en-US")}` : null)).filter(Boolean);
    const top = ev.top.slice(0, 5);
    const canEnter = ev.phase === "running" && ev.kind !== "battle" && !(ev.kind === "contest" && ev.me);
    const action = canEnter && picking !== ev.id
      ? el("button", { type: "button", className: "primary small", textContent: "Hand over a Digimon" }) : null;
    action?.addEventListener("click", () => { picking = ev.id; render(); });
    return el("article", { className: `event-card ${ev.phase}` },
      el("header", {}, el("span", { className: `tag ${ev.kind}`, textContent: KINDS[ev.kind] }),
        el("span", { className: "when", textContent: when(ev) })),
      el("h3", { textContent: ev.title }),
      ev.body ? el("p", { className: "event-body", textContent: ev.body }) : null,
      el("p", { className: "hint", textContent: what(ev) }),
      rewards.length ? el("p", { className: "event-rewards" }, el("span", { className: "coin", ariaHidden: "true" }),
        rewards.join(" . ")) : null,
      top.length ? el("ol", { className: "standings" }, ...top.map((r) => el("li", { className: r.mine ? "mine" : "" },
        el("span", { className: "place", textContent: place(r.place) }),
        el("span", { className: "who", textContent: r.name }),
        el("span", { className: "score", textContent: scoreText(ev, r.score) }),
        r.coins ? coinTag(r.coins) : null)))
        : el("p", { className: "empty", textContent: ev.phase === "upcoming" ? "Not started yet." : "No one yet: be the first!" }),
      ev.me && !ev.top.slice(0, 5).some((r) => r.mine)
        ? el("p", { className: "my-place", textContent: `You: ${place(ev.me.place)}, ${scoreText(ev, ev.me.score)}` }) : null,
      ev.me?.entries?.length && ev.kind === "contest"
        ? el("div", { className: "my-entry" }, digimonIcon(ev.me.entries[0].species, 32), el("span", { textContent: ev.me.entries[0].name }),
          statTable(savedStats(ev.me.entries[0].stats))) : null,
      action,
      picking === ev.id ? picker(ev) : null);
  }

  function render() {
    const list = [...events].sort((a, b) => ORDER[a.phase] - ORDER[b.phase]);
    root.replaceChildren(...(list.length ? list.map(card)
      : [el("p", { className: "empty", textContent: "No event right now. The admins announce them here." })]));
  }

  async function refresh() {
    try {
      events = (await api("/api/events")).events;
      ctx.badge("events", events.filter((ev) => ev.phase === "running").length);
      render();
    } catch { /* offline: try again later */ }
  }

  render();
  return { refresh };
}
