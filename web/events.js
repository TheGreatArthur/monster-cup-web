// Events, run by the admins from /admin/events (table events, web/db/schema.sql), shown on the play
// page's left panel. Three kinds:
//   battle   most online battles won against other players between the start and the end;
//   contest  best Digimon handed over: one per player, from their bank (bank.js), that fits the
//            rules { level, species } and is ranked by one stat (rules.stat: an index of the
//            save's 8 stats, or "total" for max HP + max TP + the four battle stats);
//   collect  most Digimon handed over, from the bank.
// A Digimon handed over leaves its owner's bank for good (bank status 'event'). Once an event ends,
// its standings are frozen and the places with a reward get their coins (shop.js grant): the server
// checks every minute, an admin can also end an event early.
const SETTLE_MS = 60_000;
const SHOWN_DAYS = 7;               // ended events stay on the play page that long
const TOP = 10;
const MAX_REWARDS = 20, MAX_REWARD = 1_000_000;
const STATS = [2, 3, 4, 5, 6, 7];   // the stats a contest can rank: max HP and TP, Atk, Def, Wis, Spd

const utcText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
};
const nowText = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export function createEvents({ db, readJson, sendJson, gameInfo, shop, bank }) {
  const sql = {
    all: db.prepare("SELECT * FROM events ORDER BY starts_at DESC, id DESC"),
    shown: db.prepare(`SELECT * FROM events WHERE status <> 'cancelled'
      AND ends_at >= game.utc_text(interval '-${SHOWN_DAYS} days') ORDER BY ends_at, id`),
    one: db.prepare("SELECT * FROM events WHERE id = ?"),
    due: db.prepare("SELECT * FROM events WHERE status = 'open' AND ends_at <= game.utc_text()"),
    insert: db.prepare(`INSERT INTO events (kind, title, body, starts_at, ends_at, rules, rewards, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
    update: db.prepare(`UPDATE events SET kind = ?, title = ?, body = ?, starts_at = ?, ends_at = ?, rules = ?, rewards = ?
      WHERE id = ? AND status = 'open'`),
    endNow: db.prepare("UPDATE events SET ends_at = game.utc_text() WHERE id = ? AND status = 'open'"),
    cancel: db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ? AND status = 'open'"),
    // Only one settlement pays: the one that turns the event from open to paid.
    paid: db.prepare("UPDATE events SET status = 'paid', results = ? WHERE id = ? AND status = 'open' RETURNING id"),
    wins: db.prepare(`SELECT m.winner_id AS user_id, COUNT(*) AS score, MAX(m.ended_at) AS at
      FROM online_matches m WHERE m.winner_id IS NOT NULL AND m.end_reason NOT IN ('cancelled', 'void')
        AND m.battle_at >= ? AND m.battle_at < ? GROUP BY m.winner_id`),
    entries: db.prepare(`SELECT b.id, b.user_id, b.species, b.name, b.stats, b.updated_at AS at
      FROM bank b WHERE b.event_id = ? AND b.status = 'event' ORDER BY b.updated_at, b.id`),
    names: db.prepare(`SELECT id, COALESCE(display_name, username) AS name,
      CASE WHEN avatar_url IS NOT NULL THEN '/avatar/' || id END AS avatar FROM users WHERE id = ANY(?::bigint[])`),
    entered: db.prepare("SELECT 1 FROM bank WHERE event_id = ? AND user_id = ? AND status = 'event'"),
  };

  const species = new Map(gameInfo.species.map((s) => [s.id, s]));
  const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
  const contestScore = (rules, stats) => (rules.stat === "total"
    ? STATS.reduce((sum, k) => sum + stats[k], 0) : stats[rules.stat] ?? 0);

  // Does a banked Digimon fit the contest's rules?
  function fits(ev, digimon) {
    const rules = parse(ev.rules, {});
    if (rules.species && digimon.species !== rules.species) return false;
    return !rules.level || species.get(digimon.species)?.level === rules.level;
  }

  // The standings: [{ userId, score, at, entries? }], best first (a tie goes to whoever got there first).
  async function standings(ev) {
    let rows;
    if (ev.kind === "battle") {
      rows = (await sql.wins.all(ev.starts_at, ev.ends_at)).map((r) => ({ userId: r.user_id, score: Number(r.score), at: r.at }));
    } else {
      const rules = parse(ev.rules, {}), byUser = new Map();
      for (const e of await sql.entries.all(ev.id)) {
        const stats = JSON.parse(e.stats);
        const entry = { id: e.id, species: e.species, speciesName: species.get(e.species)?.name ?? `#${e.species}`,
          name: e.name, stats, score: ev.kind === "contest" ? contestScore(rules, stats) : 1 };
        const s = byUser.get(e.user_id) ?? { userId: e.user_id, score: 0, at: e.at, entries: [] };
        s.entries.push(entry);
        if (ev.kind === "collect") { s.score += 1; s.at = e.at; } else if (entry.score > s.score) { s.score = entry.score; s.at = e.at; }
        byUser.set(e.user_id, s);
      }
      rows = [...byUser.values()];
    }
    rows.sort((a, b) => b.score - a.score || String(a.at).localeCompare(String(b.at)));
    const names = new Map((await sql.names.all(rows.map((r) => r.userId))).map((u) => [u.id, u]));
    return rows.map((r, k) => ({ ...r, place: k + 1, name: names.get(r.userId)?.name ?? "?", avatar: names.get(r.userId)?.avatar ?? null }));
  }

  // Pays the places of an ended event, once.
  async function settle(ev) {
    const table = await standings(ev);
    const rewards = parse(ev.rewards, []);
    const results = table.map((r) => ({ userId: r.userId, name: r.name, score: r.score, place: r.place,
      coins: rewards[r.place - 1] ?? 0 }));
    if (!await sql.paid.get(JSON.stringify(results), ev.id)) return;
    for (const r of results) if (r.coins > 0) await shop.grant(r.userId, r.coins, "event", ev.id);
  }
  async function settleDue() {
    for (const ev of await sql.due.all()) await settle(ev).catch((err) => console.error("events:", err));
  }
  setInterval(() => settleDue(), SETTLE_MS).unref();
  settleDue();

  function phase(ev) {
    if (ev.status === "cancelled") return "cancelled";
    if (ev.status === "paid") return "ended";
    const now = nowText();
    return now < ev.starts_at ? "upcoming" : now < ev.ends_at ? "running" : "ended";
  }

  // An event as the pages show it; with the player's own place, or every entry for the admins.
  async function view(ev, userId = null, admin = false) {
    const table = ev.status === "paid" ? parse(ev.results, []).map((r) => ({ ...r })) : await standings(ev);
    const rules = parse(ev.rules, {});
    const out = { id: ev.id, kind: ev.kind, title: ev.title, body: ev.body ?? "", startsAt: ev.starts_at, endsAt: ev.ends_at,
      phase: phase(ev), rewards: parse(ev.rewards, []),
      rules: { ...rules, speciesName: rules.species ? species.get(rules.species)?.name : undefined,
        statName: rules.stat === "total" ? "Total" : gameInfo.statLabels?.[STATS.indexOf(rules.stat)] },
      top: table.slice(0, TOP).map(({ entries, ...r }) => ({ ...r, mine: r.userId === userId })),
      players: table.length };
    if (userId !== null) {
      const me = table.find((r) => r.userId === userId);
      out.me = me ? { place: me.place, score: me.score, entries: me.entries ?? [] } : null;
    }
    if (admin) Object.assign(out, { status: ev.status, rules: { ...out.rules } });
    if (admin) out.entries = table.flatMap((r) => (r.entries ?? []).map((e) => ({ ...e, player: r.name })));
    return out;
  }

  // An event from the admin page, checked; or an error message.
  function validEvent(body) {
    if (!["battle", "contest", "collect"].includes(body.kind)) return "Pick a kind of event.";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
    if (!title) return "Give the event a title.";
    const startsAt = utcText(body.startsAt), endsAt = utcText(body.endsAt);
    if (!startsAt || !endsAt || endsAt <= startsAt) return "The event must end after it starts.";
    const rewards = Array.isArray(body.rewards) ? body.rewards : [];
    if (rewards.length > MAX_REWARDS || !rewards.every((r) => Number.isInteger(r) && r >= 0 && r <= MAX_REWARD)) {
      return "Rewards are up to 20 whole amounts of coins.";
    }
    let rules = null;
    if (body.kind !== "battle") {
      const r = body.rules ?? {};
      rules = {};
      if (r.level) rules.level = String(r.level).slice(0, 20);
      if (Number.isInteger(r.species) && species.has(r.species)) rules.species = r.species;
      if (body.kind === "contest") {
        if (r.stat !== "total" && !STATS.includes(r.stat)) return "Pick the stat the contest ranks.";
        rules.stat = r.stat;
      }
    }
    return { kind: body.kind, title, body: typeof body.body === "string" ? body.body.trim().slice(0, 600) : "",
      startsAt, endsAt, rules: rules && JSON.stringify(rules), rewards: JSON.stringify(rewards) };
  }

  return {
    // GET /api/events, POST /api/events/enter { event, bank }.
    async handle(route, req, res, user) {
      if (route === "GET /api/events") {
        const events = await Promise.all((await sql.shown.all()).map((ev) => view(ev, user.id)));
        return sendJson(res, 200, { events }), true;
      }
      if (route === "POST /api/events/enter") {
        const body = await readJson(req);
        const ev = await sql.one.get(Number.isInteger(body.event) ? body.event : -1);
        if (!ev || ev.kind === "battle" || phase(ev) !== "running") return sendJson(res, 409, { error: "This event is not open." }), true;
        if (ev.kind === "contest" && await sql.entered.get(ev.id, user.id)) {
          return sendJson(res, 409, { error: "You already entered a Digimon in this contest." }), true;
        }
        const id = Number.isInteger(body.bank) ? body.bank : -1;
        const row = await bank.peek(user.id, id);
        if (!row) return sendJson(res, 409, { error: "Pick one of your stored Digimon." }), true;
        if (!fits(ev, row)) return sendJson(res, 409, { error: "This Digimon does not fit the event's rules." }), true;
        const taken = await bank.takeForEvent(user.id, id, ev.id);
        if (!taken) return sendJson(res, 409, { error: "This Digimon cannot be handed over now." }), true;
        return sendJson(res, 200, { ok: true, event: await view(ev, user.id) }), true;
      }
      return false;
    },

    // /api/admin/events (admin.js checks the admin first).
    async handleAdmin(route, req, res, user) {
      if (route === "GET /api/admin/events") {
        const events = await Promise.all((await sql.all.all()).map((ev) => view(ev, null, true)));
        return sendJson(res, 200, { events, species: gameInfo.species.map(({ id, name, level }) => ({ id, name, level })),
          statLabels: gameInfo.statLabels }), true;
      }
      if (req.method !== "POST" || !route.startsWith("POST /api/admin/events/")) return false;
      const body = await readJson(req);
      const action = route.slice("POST /api/admin/events/".length);
      const id = Number.isInteger(body.id) ? body.id : -1;
      if (action === "save") {
        const ev = validEvent(body);
        if (typeof ev === "string") return sendJson(res, 400, { error: ev }), true;
        const values = [ev.kind, ev.title, ev.body, ev.startsAt, ev.endsAt, ev.rules, ev.rewards];
        if (id >= 0) {
          const { changes } = await sql.update.run(...values, id);
          return sendJson(res, changes ? 200 : 409, changes ? { id } : { error: "Only an open event can change." }), true;
        }
        return sendJson(res, 200, { id: (await sql.insert.run(...values, user.id)).id }), true;
      }
      if (action === "end") {
        await sql.endNow.run(id);
        const ev = await sql.one.get(id);
        if (ev?.status === "open") await settle(ev);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (action === "cancel") {
        // A cancelled event gives the Digimon handed over back to their owners' banks.
        const ok = (await sql.cancel.run(id)).changes > 0;
        if (ok) await bank.releaseEvent(id);
        return sendJson(res, 200, { ok }), true;
      }
      return false;
    },
  };
}
