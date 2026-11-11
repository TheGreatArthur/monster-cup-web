// The moderators' page (web/admin.js): accounts, suspicious pairs, flagged matches, referee jobs.
import { api, el, fill, playerLink, setStatus, updated } from "./admin-common.js";

function button(label, action) {
  const b = el("button", { type: "button", className: "pill", textContent: label });
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const result = await action();
      if (result !== false) await load();
    } catch (err) {
      setStatus(err.message, "err");
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

const actions = (...buttons) => el("span", { className: "actions" }, ...buttons);
const incidentText = (incidents) => Object.entries(incidents).map(([k, n]) => `${k} x${n}`).join(", ");

// The referee's verdict ({ winnerSide, tampered }, web/referee.js) in words.
function verdict(json) {
  if (!json) return "";
  const { winnerSide, tampered } = JSON.parse(json);
  return `${winnerSide ? `${winnerSide} wins` : "No winner"}${tampered?.length ? `, tampered: ${tampered.join(", ")}` : ""}`;
}

function accountRow(a, banPoints) {
  const state = [a.ban && `Suspended: ${a.ban}`, a.flag && `Save flagged: ${a.flag.join("; ")}`].filter(Boolean).join(". ");
  const score = el("span", { textContent: String(a.score) });
  if (a.score >= banPoints) score.className = "bad";
  return [playerLink(a.id, a.name), String(a.rating), `${a.wins}-${a.losses}`, score, incidentText(a.incidents), state,
    actions(
      a.ban
        ? button("Lift suspension", () => api("unban", { user: a.id }))
        : button("Suspend", () => {
          const reason = prompt(`Reason for suspending ${a.name}:`, "cheating");
          return reason === null ? false : api("ban", { user: a.id, reason });
        }),
      ...(a.flag ? [button("Clear flag", () => api("unflag", { user: a.id }))] : []),
      ...(a.wins ? [button("Cancel wins", async () => {
        if (!confirm(`Cancel the ${a.wins} ranked wins of ${a.name} (Elo goes back to the opponents)?`)) return false;
        const { cancelled } = await api("cancel-wins", { user: a.id });
        setStatus(`${cancelled} win(s) cancelled.`, "done");
      })] : []),
    )];
}

async function load() {
  setStatus("Loading...");
  const data = await api("overview");
  document.getElementById("admin-trust").textContent = `Trust score: incident points over ${data.trustDays} days, `
    + `plus save flags. An account is suspended automatically at ${data.banPoints}.`;
  fill(document.getElementById("admin-accounts"),
    ["Account", "Elo", "W-L", "Score", "Incidents", "State", ""],
    data.accounts.map((a) => accountRow(a, data.banPoints)));
  fill(document.getElementById("admin-pairs"),
    ["Account A", "Account B", "Matches", "Wins A-B", "Forfeits"],
    data.pairs.map((p) => [p.a, p.b, String(p.n), `${p.a_wins}-${p.b_wins}`, String(p.given)]));
  fill(document.getElementById("admin-matches"),
    ["#", "Mode", "Host", "Guest", "Winner", "End", "Referee", ""],
    data.matches.map((m) => [String(m.id), m.mode === "search" ? "ranked" : "friendly", m.host, m.guest,
      m.winner ?? "None", m.reason ?? "In progress", verdict(m.referee),
      m.replayable ? button("Replay", () => api("referee", { match: m.id })) : ""]));
  fill(document.getElementById("admin-jobs"),
    ["#", "Match", "Reason", "State", "Created"],
    data.jobs.map((j) => [String(j.id), String(j.match), j.reason, j.status, j.at]));
  updated();
}

document.getElementById("admin-refresh").addEventListener("click", () => load().catch((err) => setStatus(err.message, "err")));
load().catch((err) => setStatus(err.message, "err"));
