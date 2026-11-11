// Online battles: private rooms (a code to share) and random matchmaking. The server pairs two
// players and relays the game's Multi Battle packets between their pages (web/public/online.js);
// each game runs the battle itself from the same random seed, so both get the same result.
// Random matchmaking is ranked (Elo), private rooms are friendly (recorded, no rating change).
//
// Anti-cheat, step 1 (docs/anti_cheat_strategy.md): the pages are never trusted on their own.
// - The server follows the packet exchange (fixed order) and refuses packets out of turn.
// - The seed is only given once the team exchange starts, not when players are paired.
// - A reported defeat settles the match at once; a reported win needs the opponent's
//   confirmation, or the opponent leaving after the battle started, or the battle time limit.
// - Leaving once the battle started (teams exchanged) is a forfeit in ranked play.
// - Every match keeps a journal (packets included, for a later replay check), incidents are
//   counted per player, and the online API is rate limited.
//
// Step 2: ranked play needs a save that passed the checks (save-check.js, server.js), and each
// Digimon a page relays must be one of the Digimon of the player's save on the server.
//
// Step 3: disputed ranked matches, and a random sample of the others, go to the referee
// (referee.js), which replays them from the saves and the journal; its verdict is final. The
// referee also learns the whole record the game sends for a saved Digimon: once known, a relayed
// Digimon must match it byte for byte; a ranked match with a Digimon not known yet is always
// replayed, whatever its result.
//
// Step 4: ranked play is refused to banned, flagged and brand-new accounts (sanctions.js). The
// random search pairs players by rating (a window that widens while they wait), never two
// accounts of one browser or one public IP address, and at most a few times a day the same two.
//
// The match state lives in memory and changes synchronously; its database writes go through one
// queue per match (write()), so the journal keeps the order of the packets.
import { randomInt } from "node:crypto";
import { matchPacket, describePacket } from "./save-check.js";
import { background } from "./db.js";

// A room code is 6 digits, the first not 0: the game shows it on its Friend Code screen and the
// opponent types it on the game's number pad. The game proposes it (the page's offer).
const CODE_PATTERN = /^[1-9][0-9]{5}$/;
const MAX_RELAY_CHARS = 256;   // one 128-byte game packet, base64 (172 characters)
const START_RATING = 1000;
const ELO_K = 32;
const LADDER_SIZE = 50;
// Who sends each packet of the game's exchange (docs/multiplayer_analysis.md §4.2): settings
// (terrain, team names), then teams (0x4C each), then the 3 Digimon slots (0x6C each).
const EXCHANGE = "HGH" + "HG" + "HGHGHG";
const TEAMS_START = 3;          // first packet of the team exchange: the seed goes out with it
const DIGIMON_START = 5;        // first packet holding a team member (one per packet from here)
// After the last packet the battle runs in each game on its own (120 s per round, up to 3
// rounds, plus animations): a side without a result after this long forfeits.
const BATTLE_TIME_LIMIT_MS = Number(process.env.ONLINE_BATTLE_LIMIT_MS ?? 10 * 60_000);
// Requests per minute and per player, by route.
const RATE_LIMITS = { send: 120, result: 10, search: 20, room: 20, join: 20, leave: 30, ladder: 60, events: 20 };
// Ranked pairing: rating gap allowed, widened every 10 s of waiting; ranked battles per day
// between the same two accounts.
const ELO_WINDOW = 150, ELO_WINDOW_GROWTH = 50;
const DAILY_PAIR_LIMIT = Number(process.env.RANKED_DAILY_PAIR ?? 5);
const PAIRING_MS = 2000;
const isLoopback = (ip) => /^(::1|127\.|::ffff:127\.)/.test(ip ?? "");
// Share of the ranked matches settled by both reports that the referee checks anyway.
const REFEREE_SAMPLE = Number(process.env.REFEREE_SAMPLE ?? 0.05);

// saves: { flagged(userId), digimon(userId), data(userId), knownRecord(hash) } from server.js.
// hooks, filled in by server.js once these exist: enqueue(matchId, reason) (referee.js),
// review(userId) and rankedRefusal(userId) (sanctions.js), coins.award / coins.revoke (shop.js).
// The returned handler also has applyVerdict() and cancelWins().
//
// Tables (web/db/schema.sql): online_matches, ratings, online_match_events (everything that happened
// in a match: packet, seed, battle, result, leave, end, referee), online_incidents (cancel, forfeit,
// timeout, disputed, protocol, team, tampered, lied) and online_match_saves (each side's save when
// the battle started and the farm slots of its team, null = empty position: what the referee
// replays). end_reason: 'finished' (both reports agree), 'conceded' (a defeat was reported),
// 'forfeit' (left or silent during the battle), 'disputed', 'void' (nobody reported in time),
// 'left' (before the battle), 'protocol', 'team' (a relayed Digimon is not in the player's save),
// 'refereed' (the referee changed the result), 'cancelled' (an admin undid a cheater's win).
export function createOnline(db, readJson, sendJson, saves, hooks) {
  const sql = {
    insertMatch: db.prepare("INSERT INTO online_matches (mode, host_id, guest_id, seed) VALUES (?, ?, ?, ?) RETURNING id"),
    battleStarted: db.prepare("UPDATE online_matches SET battle_at = game.utc_text() WHERE id = ?"),
    snapshot: db.prepare("INSERT INTO online_match_saves (match_id, side, user_id, data, slots) VALUES (?, ?, ?, ?, ?)"),
    deltas: db.prepare("UPDATE online_matches SET host_delta = ?, guest_delta = ? WHERE id = ?"),
    matchRow: db.prepare(`SELECT mode, host_id, guest_id, winner_id, host_won, guest_won, host_delta, guest_delta
      FROM online_matches WHERE id = ?`),
    refereed: db.prepare("UPDATE online_matches SET referee = ?, winner_id = ?, end_reason = COALESCE(?, end_reason) WHERE id = ?"),
    endMatch: db.prepare("UPDATE online_matches SET ended_at = game.utc_text(), end_reason = ?, winner_id = ? WHERE id = ?"),
    report: {
      host: db.prepare("UPDATE online_matches SET host_won = ? WHERE id = ?"),
      guest: db.prepare("UPDATE online_matches SET guest_won = ? WHERE id = ?"),
    },
    event: db.prepare("INSERT INTO online_match_events (match_id, user_id, kind, detail) VALUES (?, ?, ?, ?)"),
    incident: db.prepare("INSERT INTO online_incidents (user_id, match_id, kind) VALUES (?, ?, ?)"),
    ensureRating: db.prepare("INSERT INTO ratings (user_id) VALUES (?) ON CONFLICT DO NOTHING"),
    rating: db.prepare("SELECT rating, wins, losses FROM ratings WHERE user_id = ?"),
    setRating: db.prepare("UPDATE ratings SET rating = ?, wins = wins + ?, losses = losses + ? WHERE user_id = ?"),
    // Ranked battles of the last day, per pair of accounts (a < b).
    pairsToday: db.prepare(`SELECT LEAST(host_id, guest_id) AS a, GREATEST(host_id, guest_id) AS b, COUNT(*) AS n
      FROM online_matches WHERE mode = 'search' AND battle_at >= game.utc_text(interval '-1 day') GROUP BY 1, 2`),
    wonMatches: db.prepare(`SELECT id, host_id, guest_id, host_delta, guest_delta FROM online_matches
      WHERE mode = 'search' AND winner_id = ? AND host_delta IS NOT NULL`),
    cancelMatch: db.prepare(`UPDATE online_matches SET end_reason = 'cancelled', winner_id = NULL,
      host_delta = NULL, guest_delta = NULL WHERE id = ?`),
    ladder: db.prepare(`SELECT u.id, COALESCE(u.display_name, u.username) AS name, u.username,
      CASE WHEN u.avatar_url IS NOT NULL THEN '/avatar/' || u.id END AS avatar, r.rating, r.wins, r.losses FROM ratings r
      JOIN users u ON u.id = r.user_id WHERE r.wins + r.losses > 0
      ORDER BY r.rating DESC, r.wins DESC LIMIT ${LADDER_SIZE}`),
  };

  const players = new Map();   // user id -> { name, stream, pending: [], room, match }
  const rooms = new Map();     // code -> host user id
  const queue = [];            // ranked search: { userId, rating, since, device, ip }
  const rates = new Map();     // "user:route" -> { minute, count }

  function player(user) {
    let p = players.get(user.id);
    if (!p) {
      p = { name: user.username, stream: null, pending: [], room: null, match: null };
      players.set(user.id, p);
    }
    return p;
  }

  function emit(userId, event) {
    const p = players.get(userId);
    if (!p) return;
    if (p.stream) p.stream.write(`data: ${JSON.stringify(event)}\n\n`);
    else p.pending.push(event);
  }

  function limited(userId, name) {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${userId}:${name}`;
    const rate = rates.get(key);
    if (!rate || rate.minute !== minute) {
      rates.set(key, { minute, count: 1 });
      return false;
    }
    return ++rate.count > RATE_LIMITS[name];
  }

  async function ratingOf(userId) {
    await sql.ensureRating.run(userId);
    return sql.rating.get(userId);
  }

  const sideOf = (match, userId) => (match.host === userId ? "host" : "guest");
  const idOf = (match, side) => (side === "host" ? match.host : match.guest);
  const other = (side) => (side === "host" ? "guest" : "host");

  // Runs fn (database work for the match) after the match's earlier writes; returns its promise.
  // A failed write is logged and does not stop the next ones.
  function write(match, fn) {
    const done = match.queue.then(fn);
    match.queue = done.catch((err) => console.error(`online match ${match.id}:`, err));
    return done;
  }
  const log = (match, userId, kind, detail = null) => write(match, () => sql.event.run(match.id, userId, kind, detail));
  // A match row known only by its id (the referee's verdict, an admin's cancel).
  const pastMatch = (id) => ({ id, queue: Promise.resolve() });

  // Pairs two players: their pages learn it once the match has its id.
  async function startMatch(mode, hostId, guestId) {
    // Seed for the game's random generator (ARM9 0x020426C8): any non-zero value. Kept secret
    // until the team exchange starts.
    const seed = randomInt(1, 2 ** 31);
    const match = { id: null, mode, host: hostId, guest: guestId, seed, packets: 0, battle: false,
      won: {}, left: {}, used: { host: new Set(), guest: new Set() }, slots: { host: [], guest: [] },
      replayable: true, unverified: false, timer: null, over: false };
    match.queue = sql.insertMatch.run(mode, hostId, guestId, seed).then(({ id }) => { match.id = id; });
    for (const userId of [hostId, guestId]) {
      players.get(userId).match = match;
      players.get(userId).pending = [];   // events of an earlier match, never delivered
    }
    try {
      await match.queue;
    } catch (err) {   // not recorded: the match does not happen
      detach(match);
      match.queue = Promise.resolve();
      for (const userId of [hostId, guestId]) emit(userId, { type: "left" });
      throw err;
    }
    if (match.over) return;   // a player left in the meantime
    const ranked = mode === "search";
    emit(hostId, { type: "matched", role: 1, opponent: players.get(guestId).name, match: match.id, ranked });
    emit(guestId, { type: "matched", role: 2, opponent: players.get(hostId).name, match: match.id, ranked });
  }

  function detach(match) {
    clearTimeout(match.timer);
    match.over = true;
    for (const userId of [match.host, match.guest]) {
      if (players.get(userId)?.match === match) players.get(userId).match = null;
    }
  }

  // Ends the match. winnerSide null = no winner (disputed, void, cancelled). culprit: the player
  // who broke the rules, when one did.
  // Ends the match. winnerSide null = no winner (disputed, void, cancelled). culprit: the player
  // who broke the rules, when one did. The pages learn the result once it is written.
  async function settle(match, winnerSide, reason, culprit = null) {
    if (match.over) return;
    detach(match);
    const winner = winnerSide && idOf(match, winnerSide);
    const loser = winnerSide && idOf(match, other(winnerSide));
    const ranked = match.mode === "search";
    const change = await write(match, async () => {
      await sql.endMatch.run(reason, winner ?? null, match.id);
      await sql.event.run(match.id, null, "end", JSON.stringify({ reason, winner }));
      return winner && ranked ? elo(match.id, match.host, winner, loser) : {};
    }).catch(() => ({}));   // already logged by write(): the pages still get the result
    // Any win against another player pays PvP coins (shop.js), ranked or not.
    const coins = winner ? await payWin(match.id, winner, loser) : undefined;
    for (const userId of [match.host, match.guest]) {
      emit(userId, { type: "result", status: winner ? "finished" : reason, reason, ranked,
        won: winner ? userId === winner : null, ...(culprit && { culprit: userId === culprit }),
        ...(userId === winner && coins !== undefined && { coins }), ...change[userId] });
    }
    if (ranked && match.battle && match.replayable) {
      if (reason === "disputed" || match.unverified) await hooks.enqueue?.(match.id, reason === "disputed" ? "disputed" : "unverified");
      else if (Math.random() < REFEREE_SAMPLE) await hooks.enqueue?.(match.id, "sample");
    }
  }
  const payWin = (matchId, winner, loser) => hooks.coins?.award(matchId, winner, loser)
    .catch((err) => console.error("coins:", err));
  const takeWinBack = (matchId, userId) => hooks.coins?.revoke(matchId, userId)
    .catch((err) => console.error("coins:", err));
  // settle() from places nobody awaits (timers, closed pages, other routes' side effects).
  const settleLater = (...args) => background(settle(...args), "online");

  // Rates a ranked win; returns { [user id]: { rating, delta } }.
  async function elo(matchId, hostId, winner, loser) {
    const w = await ratingOf(winner), l = await ratingOf(loser);
    const expected = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
    const delta = Math.max(1, Math.round(ELO_K * (1 - expected)));
    await sql.setRating.run(w.rating + delta, 1, 0, winner);
    await sql.setRating.run(l.rating - delta, 0, 1, loser);
    await sql.deltas.run(winner === hostId ? delta : -delta, winner === hostId ? -delta : delta, matchId);
    return { [winner]: { rating: w.rating + delta, delta }, [loser]: { rating: l.rating - delta, delta: -delta } };
  }

  // The referee's verdict (referee.js): { winnerSide, tampered: [sides], results }. A side that
  // relayed a doctored team, or reported the opposite of the replay, gets an incident. A ranked
  // result that differs from the replay is corrected: the earlier Elo change is undone first.
  async function applyVerdict(matchId, { winnerSide, tampered, results }) {
    const row = await sql.matchRow.get(matchId);
    if (!row) return;
    const match = pastMatch(matchId);
    const ids = { host: row.host_id, guest: row.guest_id };
    await sql.event.run(matchId, null, "referee", JSON.stringify({ winnerSide, tampered, results }));
    for (const side of tampered) await incident(match, ids[side], "tampered");
    const reported = { host: row.host_won, guest: row.guest_won };
    // A doctored team fools the other game too: its player's report is not a lie then.
    for (const side of winnerSide && !tampered.length ? ["host", "guest"] : []) {
      if (reported[side] !== null && !tampered.includes(side) && Boolean(reported[side]) !== (side === winnerSide)) {
        await incident(match, ids[side], "lied");
      }
    }
    const winner = winnerSide ? ids[winnerSide] : null;
    const changed = winner !== null && winner !== row.winner_id;
    await sql.refereed.run(JSON.stringify({ winnerSide, tampered }), changed ? winner : row.winner_id,
      changed ? "refereed" : null, matchId);
    if (!changed) return;
    if (row.winner_id) await takeWinBack(matchId, row.winner_id);
    const coins = await payWin(matchId, winner, winner === row.host_id ? row.guest_id : row.host_id);
    const ranked = row.mode === "search";
    let change = {};
    if (ranked) {
      for (const side of ["host", "guest"]) {
        const delta = row[`${side}_delta`];
        if (delta === null) continue;
        const r = await ratingOf(ids[side]);
        await sql.setRating.run(r.rating - delta, delta > 0 ? -1 : 0, delta < 0 ? -1 : 0, ids[side]);
      }
      change = await elo(matchId, row.host_id, winner, ids[winnerSide === "host" ? "guest" : "host"]);
    }
    for (const userId of [row.host_id, row.guest_id]) {
      emit(userId, { type: "referee", match: matchId, ranked, won: userId === winner,
        ...(userId === winner && coins !== undefined && { coins }), ...change[userId] });
    }
  }

  // Every incident counts towards the trust score, which may ban the account from ranked play.
  function incident(match, userId, kind) {
    return write(match, async () => {
      await sql.incident.run(userId, match.id, kind);
      await hooks.review?.(userId);
    }).catch(() => {});   // already logged by write()
  }

  // The battle runs in each game once the last packet is relayed.
  function startBattle(match) {
    match.battle = true;
    write(match, async () => {
      await sql.battleStarted.run(match.id);
      await sql.event.run(match.id, null, "battle", null);
      if (!match.replayable) return;
      for (const side of ["host", "guest"]) {
        const userId = idOf(match, side);
        await sql.snapshot.run(match.id, side, userId, await saves.data(userId), JSON.stringify(match.slots[side]));
      }
    }).catch(() => {});
    match.timer = setTimeout(() => timeUp(match), BATTLE_TIME_LIMIT_MS);
  }

  // A side said nothing in time: a lone win stands, a silent side forfeits.
  function timeUp(match) {
    const sides = Object.keys(match.won);
    if (sides.length === 1) {
      incident(match, idOf(match, other(sides[0])), "timeout");
      settleLater(match, sides[0], "forfeit");
    } else if (sides.length === 0) {
      for (const side of ["host", "guest"]) incident(match, idOf(match, side), "timeout");
      settleLater(match, null, "void");
    }
  }

  // A defeat report is believed at once (nobody lies to lose); a win needs the other side.
  function report(match, side, won) {
    match.won[side] = won;
    write(match, () => sql.report[side].run(won ? 1 : 0, match.id)).catch(() => {});
    log(match, idOf(match, side), "result", won ? "won" : "lost").catch(() => {});
    const theirs = match.won[other(side)];
    if (theirs !== undefined) {
      if (theirs !== won) return settleLater(match, won ? side : other(side), "finished");
      for (const s of ["host", "guest"]) incident(match, idOf(match, s), "disputed");
      return settleLater(match, null, "disputed");
    }
    if (!won) return settleLater(match, other(side), "conceded");
    if (match.left[other(side)]) settleLater(match, side, "forfeit");
  }

  // Cancels whatever the player is doing: room, search, or match (the opponent is told).
  function leave(userId) {
    const p = players.get(userId);
    if (!p) return;
    if (p.room) rooms.delete(p.room);
    p.room = null;
    const queued = queue.findIndex((q) => q.userId === userId);
    if (queued >= 0) queue.splice(queued, 1);
    const match = p.match;
    if (!match) return;
    p.match = null;
    const side = sideOf(match, userId);
    log(match, userId, "leave", match.battle ? "battle" : "before battle").catch(() => {});
    if (!match.battle) {
      // Before the teams are exchanged nothing is decided: the match is cancelled.
      incident(match, userId, "cancel");
      emit(idOf(match, other(side)), { type: "left" });
      return settleLater(match, null, "left");
    }
    // During the battle the link is no longer needed: wait for the result. Leaving without one is
    // a forfeit once the opponent reports a win (or at the time limit).
    match.left[side] = true;
    if (match.won[side] !== undefined) return;
    incident(match, userId, "forfeit");
    if (match.won[other(side)] === true) settleLater(match, other(side), "forfeit");
  }

  // A team member about to be relayed (the exchange's packet number index) must be one of the
  // sender's saved Digimon, each sent once. In ranked play anything else cancels the match before
  // the battle; in a friendly match it is only logged. Returns false when the packet is refused.
  async function checkMember(match, side, packet, index) {
    const userId = idOf(match, side);
    const [digimon, flagged] = await Promise.all([saves.digimon(userId), match.mode === "search" && saves.flagged(userId)]);
    let found = digimon && packet.length >= 0x6c ? matchPacket(packet, digimon, match.used[side]) : null;
    if (found && found !== "empty") {
      const known = await saves.knownRecord(found.record);
      if (!known) match.unverified = true;
      else if (!packet.subarray(0, known.length).equals(known)) found = null;
    }
    if (found && found !== "empty") match.used[side].add(found.slot);
    match.slots[side].push(found && found !== "empty" ? found.slot : null);
    if (!found) match.replayable = false;   // not in the save: the referee cannot replay it
    // The side's last member packet: a team needs at least one Digimon.
    const last = EXCHANGE.lastIndexOf(side === "host" ? "H" : "G") === index;
    const ok = found && !(last && match.used[side].size === 0);
    if (ok && !flagged) return true;
    log(match, userId, "team", JSON.stringify(packet.length >= 0x6c ? describePacket(packet) : { size: packet.length })).catch(() => {});
    if (match.mode !== "search") return true;
    incident(match, userId, "team");
    settleLater(match, null, "team", userId);
    return false;
  }

  // Two searching players who may meet in ranked play. pairs: "a:b" (a < b) -> ranked battles today.
  function compatible(a, b, now, pairs) {
    if (a.device === b.device) return false;                     // one browser, two accounts
    if (a.ip === b.ip && !isLoopback(a.ip)) return false;       // one connection (the local prototype is exempt)
    if ((pairs.get(`${Math.min(a.userId, b.userId)}:${Math.max(a.userId, b.userId)}`) ?? 0) >= DAILY_PAIR_LIMIT) return false;
    const waited = now - Math.min(a.since, b.since);
    return Math.abs(a.rating - b.rating) <= ELO_WINDOW + ELO_WINDOW_GROWTH * Math.floor(waited / 10_000);
  }

  // Pairs the longest-waiting players first, each with the closest rating it may meet. One run at
  // a time: a call during a run waits for it.
  let pairing = null;
  function pairQueue() {
    pairing ??= (async () => {
      if (queue.length < 2) return;
      const pairs = new Map((await sql.pairsToday.all()).map((p) => [`${p.a}:${p.b}`, p.n]));
      const now = Date.now();
      for (let i = 0; i < queue.length; i++) {
        const a = queue[i];
        let best = -1;
        for (let j = i + 1; j < queue.length; j++) {
          if (compatible(a, queue[j], now, pairs)
            && (best < 0 || Math.abs(queue[j].rating - a.rating) < Math.abs(queue[best].rating - a.rating))) best = j;
        }
        if (best < 0) continue;
        const b = queue[best];
        queue.splice(best, 1);
        queue.splice(i, 1);
        i--;
        background(startMatch("search", a.userId, b.userId), "online");
      }
    })().finally(() => { pairing = null; });
    return pairing;
  }
  setInterval(() => background(pairQueue(), "online"), PAIRING_MS).unref();

  // Undoes the ranked wins of an account (a cheater's, from the admin page): both sides get
  // their rating, wins and losses back. Returns the number of matches cancelled.
  async function cancelWins(userId) {
    const matches = await sql.wonMatches.all(userId);
    for (const m of matches) {
      for (const [id, delta] of [[m.host_id, m.host_delta], [m.guest_id, m.guest_delta]]) {
        const r = await ratingOf(id);
        await sql.setRating.run(r.rating - delta, delta > 0 ? -1 : 0, delta < 0 ? -1 : 0, id);
      }
      await sql.cancelMatch.run(m.id);
      await takeWinBack(m.id, userId);
      await sql.event.run(m.id, null, "end", JSON.stringify({ reason: "cancelled" }));
    }
    return matches.length;
  }

  function newCode() {
    let code;
    do code = String(randomInt(100000, 1000000));
    while (rooms.has(code));
    return code;
  }

  const ROUTES = {
    "GET /api/online/events": "events", "POST /api/online/room": "room", "POST /api/online/join": "join",
    "POST /api/online/search": "search", "POST /api/online/send": "send", "POST /api/online/result": "result",
    "GET /api/online/ladder": "ladder", "POST /api/online/leave": "leave",
  };

  // Returns true when the route was an online one (and the response was sent).
  async function handleOnline(route, req, res, user) {
    const name = ROUTES[route];
    if (!name) return false;
    if (limited(user.id, name)) return sendJson(res, 429, { reason: "rate_limited", error: "Trop de requêtes, réessaie dans une minute." }), true;

    if (name === "events") {
      const p = player(user);
      p.stream?.end();
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      p.stream = res;
      for (const event of p.pending.splice(0)) emit(user.id, event);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        if (p.stream === res) {
          p.stream = null;
          leave(user.id);   // closing the page ends the room, search or match
        }
      });
      return true;
    }

    if (name === "room") {
      const { code } = await readJson(req);
      if (code !== undefined && !CODE_PATTERN.test(code)) return sendJson(res, 400, { reason: "invalid_code", error: "Code de room invalide." }), true;
      leave(user.id);
      if (code !== undefined && rooms.has(code)) return sendJson(res, 409, { reason: "code_taken", error: "Ce code de room est déjà pris." }), true;
      const p = player(user);
      p.room = code ?? newCode();
      rooms.set(p.room, user.id);
      sendJson(res, 201, { code: p.room });
      return true;
    }

    if (name === "join") {
      const { code } = await readJson(req);
      const hostId = typeof code === "string" ? rooms.get(code.trim()) : undefined;
      if (hostId === undefined) return sendJson(res, 404, { reason: "room_not_found", error: "Room introuvable." }), true;
      if (hostId === user.id) return sendJson(res, 409, { reason: "own_room", error: "C'est ta propre room." }), true;
      leave(user.id);
      player(user);
      rooms.delete(players.get(hostId).room);
      players.get(hostId).room = null;
      await startMatch("room", hostId, user.id);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (name === "search") {
      await readJson(req);
      const refusal = await hooks.rankedRefusal?.(user.id);
      if (refusal) return sendJson(res, 403, refusal), true;
      const { rating } = await ratingOf(user.id);
      leave(user.id);
      const p = player(user);
      queue.push({ userId: user.id, rating, since: Date.now(), device: req.device, ip: req.clientIp });
      await pairQueue();
      if (p.match) sendJson(res, 200, { status: "matched" });
      else sendJson(res, 202, { status: "searching" });
      return true;
    }

    if (name === "send") {
      const { data } = await readJson(req);
      const match = players.get(user.id)?.match;
      if (!match) return sendJson(res, 409, { error: "Pas de match en cours." }), true;
      if (typeof data !== "string" || data.length > MAX_RELAY_CHARS) {
        return sendJson(res, 400, { error: "Message invalide." }), true;
      }
      const side = sideOf(match, user.id);
      const index = match.packets;
      if (match.battle || EXCHANGE[index] !== (side === "host" ? "H" : "G")) {
        // Out of turn: a modified page. Before the battle the other game would hang, so the match
        // is cancelled; during the battle the packet is only refused (cancelling would let a
        // losing player escape).
        log(match, user.id, "packet", "out of turn").catch(() => {});
        incident(match, user.id, "protocol");
        if (!match.battle) settleLater(match, null, "protocol");
        return sendJson(res, 409, { error: "Paquet hors protocole." }), true;
      }
      // The turn is taken now: another packet before this one is relayed is out of turn.
      match.packets++;
      if (index >= DIGIMON_START && !await checkMember(match, side, Buffer.from(data, "base64"), index)) {
        return sendJson(res, 409, { error: "Digimon absent de ta sauvegarde en ligne." }), true;
      }
      if (match.over) return sendJson(res, 409, { error: "Pas de match en cours." }), true;
      log(match, user.id, "packet", data).catch(() => {});
      if (index === TEAMS_START) {
        log(match, null, "seed", String(match.seed)).catch(() => {});
        for (const userId of [match.host, match.guest]) emit(userId, { type: "seed", seed: match.seed });
      }
      emit(idOf(match, other(side)), { type: "packet", data });
      if (match.packets === EXCHANGE.length) startBattle(match);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // The page read the battle's outcome in its game: { won: true | false }.
    if (name === "result") {
      const { won } = await readJson(req);
      const match = players.get(user.id)?.match;
      if (!match) return sendJson(res, 409, { error: "Pas de match en cours." }), true;
      if (typeof won !== "boolean") return sendJson(res, 400, { error: "Résultat invalide." }), true;
      if (!match.battle) return sendJson(res, 409, { error: "Le combat n'a pas commencé." }), true;
      const side = sideOf(match, user.id);
      if (side in match.won) return sendJson(res, 409, { error: "Résultat déjà envoyé." }), true;
      report(match, side, won);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (name === "ladder") {
      const [ladder, me] = await Promise.all([sql.ladder.all(), ratingOf(user.id)]);
      sendJson(res, 200, { ladder, me: { id: user.id, ...me } });
      return true;
    }

    if (name === "leave") {
      await readJson(req);
      leave(user.id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  handleOnline.applyVerdict = applyVerdict;
  handleOnline.cancelWins = cancelWins;
  return handleOnline;
}
