// Anti-cheat, step 4: the moderators' page (/admin). It lists the accounts with their trust
// score, the matches worth a look, the referee's jobs and the suspicious pairs (two accounts that
// meet often in ranked play with one side nearly always winning: win trading or a farm account),
// and lets an admin ban or unban an account from ranked play, clear a save flag, cancel a
// cheater's ranked wins and send a match to the referee again.
// /admin/players lists the accounts live: who is playing right now (presence.js) and what their save
// holds (save-info.js). /admin/player?id= shows one account's whole save (Digimon, cages, medals)
// and sends it a gift; /admin/gifts sends a player bits, an item, a Digimon or one of the game's mails (gifts.js).
// /admin/shop edits the shop's catalogue (shop.js), /admin/events runs the events (events.js).
import { MAX_BITS, MAX_BONUS } from "./gifts.js";

// Admins are the accounts named in ADMIN_USERS (comma separated, default "admin"), and the
// accounts whose Discord user id is in ADMIN_DISCORD_IDS (comma separated).
const list = (value) => new Set((value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const ADMINS = list(process.env.ADMIN_USERS ?? "admin");
const ADMIN_DISCORD_IDS = list(process.env.ADMIN_DISCORD_IDS);
// A pair is suspicious from this many ranked battles in PAIR_DAYS with one side winning at least
// PAIR_SHARE of them.
const PAIR_MATCHES = 3, PAIR_SHARE = 0.8, PAIR_DAYS = 30;
const LIST_SIZE = 50;

export function createAdmin({ db, readJson, sendJson, serveStatic, sanctions, online, referee, gifts, presence, gameInfo,
  playerProfile, shop, events }) {
  const sql = {
    accounts: db.prepare(`SELECT u.id, u.username AS name, u.created_at AS created,
        COALESCE(r.rating, 1000) AS rating, COALESCE(r.wins, 0) AS wins, COALESCE(r.losses, 0) AS losses,
        f.problems AS flag, b.reason AS ban, b.at AS banned_at
      FROM users u LEFT JOIN ratings r ON r.user_id = u.id LEFT JOIN save_flags f ON f.user_id = u.id
      LEFT JOIN ranked_bans b ON b.user_id = u.id ORDER BY u.id`),
    incidents: db.prepare(`SELECT user_id, kind, COUNT(*) AS n FROM online_incidents
      WHERE at >= game.utc_text(interval '-${sanctions.TRUST_DAYS} days') GROUP BY user_id, kind`),
    matches: db.prepare(`SELECT m.id, m.mode, h.username AS host, g.username AS guest, w.username AS winner,
        m.started_at AS at, m.end_reason AS reason, m.referee,
        EXISTS (SELECT 1 FROM online_match_saves s WHERE s.match_id = m.id) AS replayable
      FROM online_matches m JOIN users h ON h.id = m.host_id JOIN users g ON g.id = m.guest_id
      LEFT JOIN users w ON w.id = m.winner_id
      WHERE m.end_reason IN ('disputed', 'team', 'refereed', 'cancelled') OR m.referee IS NOT NULL
        OR EXISTS (SELECT 1 FROM online_incidents i WHERE i.match_id = m.id AND i.kind <> 'cancel')
      ORDER BY m.id DESC LIMIT ${LIST_SIZE}`),
    jobs: db.prepare(`SELECT id, match_id AS match, reason, status, created_at AS at, results
      FROM referee_jobs ORDER BY id DESC LIMIT ${LIST_SIZE}`),
    pairs: db.prepare(`SELECT * FROM (
        SELECT LEAST(host_id, guest_id) AS a, GREATEST(host_id, guest_id) AS b, COUNT(*) AS n,
          COUNT(*) FILTER (WHERE winner_id = LEAST(host_id, guest_id)) AS a_wins,
          COUNT(*) FILTER (WHERE winner_id = GREATEST(host_id, guest_id)) AS b_wins,
          COUNT(*) FILTER (WHERE end_reason IN ('conceded', 'forfeit')) AS given
        FROM online_matches WHERE mode = 'search' AND battle_at >= game.utc_text(interval '-${PAIR_DAYS} days')
          AND end_reason <> 'cancelled'
        GROUP BY 1, 2) p
      WHERE n >= ${PAIR_MATCHES} AND GREATEST(a_wins, b_wins) >= n * ${PAIR_SHARE}
      ORDER BY n DESC`),
    user: db.prepare("SELECT id, username FROM users WHERE id = ?"),
    unflag: db.prepare("DELETE FROM save_flags WHERE user_id = ?"),
    replayable: db.prepare("SELECT 1 FROM online_match_saves WHERE match_id = ?"),
    players: db.prepare(`SELECT u.id, u.username AS name, u.created_at AS created, COALESCE(r.rating, 1000) AS rating,
        COALESCE(r.wins, 0) AS wins, COALESCE(r.losses, 0) AS losses,
        (SELECT COUNT(*) FROM gifts g WHERE g.user_id = u.id AND g.status = 'pending') AS pending
      FROM users u LEFT JOIN ratings r ON r.user_id = u.id ORDER BY u.id`),
  };
  const PAGES = { "GET /admin": "admin.html", "GET /admin/players": "admin-players.html",
    "GET /admin/player": "admin-player.html", "GET /admin/gifts": "admin-gifts.html",
    "GET /admin/shop": "admin-shop.html", "GET /admin/events": "admin-events.html" };

  const OFFLINE = { online: false, seen: null, state: null };

  async function players() {
    const [seen, rows] = await Promise.all([presence.all(), sql.players.all()]);
    return Promise.all(rows.map(async (p) => {
      const save = await playerProfile(p.id);
      return { ...p, presence: seen.get(p.id) ?? OFFLINE, save: save && (save.error ? { error: save.error, updated: save.updated } : {
        updated: save.updated, tamer: save.tamer, bits: save.bits, rank: save.rank, playTime: save.playTime,
        team: save.digimon.map((d) => d.speciesId), digimon: save.digimon.length, cups: save.cups.length, dex: save.dex }) };
    }));
  }

  function giftOptions() {
    return { items: gameInfo.items, species: gameInfo.species, mails: gameInfo.mails.filter((m) => m.giftable),
      statLabels: gameInfo.statLabels, apLabels: gameInfo.apLabels, maxBits: MAX_BITS, maxBonus: MAX_BONUS };
  }

  const isAdmin = (user) => user !== undefined
    && (ADMINS.has(user.username.toLowerCase()) || ADMIN_DISCORD_IDS.has(user.discord_id ?? ""));

  async function overview() {
    const incidents = new Map();
    for (const { user_id: id, kind, n } of await sql.incidents.all()) {
      incidents.set(id, { ...incidents.get(id), [kind]: n });
    }
    const accounts = await Promise.all((await sql.accounts.all()).map(async (a) => ({ ...a, score: await sanctions.score(a.id),
      incidents: incidents.get(a.id) ?? {}, flag: a.flag && JSON.parse(a.flag) })));
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    const [pairs, matches, jobs] = await Promise.all([sql.pairs.all(), sql.matches.all(), sql.jobs.all()]);
    return { accounts, matches, jobs, pairs: pairs.map((p) => ({ ...p, a: names.get(p.a), b: names.get(p.b) })),
      banPoints: sanctions.BAN_POINTS, trustDays: sanctions.TRUST_DAYS };
  }

  // Returns true when it handled the request. user: the logged-in account (or undefined).
  return async function handleAdmin(route, req, res, user, url) {
    if (!PAGES[route] && !url.pathname.startsWith("/api/admin/")) return false;
    if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only." }), true;
    if (PAGES[route]) return serveStatic(res, PAGES[route]), true;
    if (route === "GET /api/admin/overview") return sendJson(res, 200, await overview()), true;
    if (route === "GET /api/admin/players") return sendJson(res, 200, { players: await players() }), true;
    if (route === "GET /api/admin/player") {
      const id = Number(url.searchParams.get("id"));
      const target = (await sql.players.all()).find((p) => p.id === id);
      if (!target) return sendJson(res, 404, { error: "Unknown account." }), true;
      return sendJson(res, 200, { ...target, presence: (await presence.all()).get(id) ?? OFFLINE, save: await playerProfile(id),
        gifts: await gifts.forUser(id) }), true;
    }
    if (route === "GET /api/admin/gift-options") return sendJson(res, 200, giftOptions()), true;
    if (route === "GET /api/admin/gifts") return sendJson(res, 200, { gifts: await gifts.history() }), true;
    // The shop's catalogue (shop.js) and the events (events.js).
    if (url.pathname.startsWith("/api/admin/shop")) return shop.handleAdmin(route, req, res);
    if (url.pathname.startsWith("/api/admin/events")) return events.handleAdmin(route, req, res, user);
    if (req.method !== "POST") return false;

    const body = await readJson(req);
    const action = url.pathname.slice("/api/admin/".length);
    const id = (value) => (Number.isInteger(value) ? value : -1);   // ids from the page: never a malformed query
    if (action === "referee") {
      if (!await sql.replayable.get(id(body.match))) return sendJson(res, 409, { error: "This match cannot be replayed." }), true;
      await referee.enqueue(body.match, "admin");
      return sendJson(res, 200, { ok: true }), true;
    }
    if (action === "gift-cancel") return sendJson(res, 200, { ok: await gifts.cancel(id(body.gift)) }), true;
    const target = await sql.user.get(id(body.user));
    if (!target) return sendJson(res, 404, { error: "Unknown account." }), true;
    if (action === "gift") {
      const gift = gifts.validate(body);
      if (typeof gift === "string") return sendJson(res, 400, { error: gift }), true;
      const note = typeof body.note === "string" ? body.note.slice(0, 200) : "";
      return sendJson(res, 200, { id: await gifts.create(target.id, gift, note, user.id) }), true;
    }
    if (action === "ban") {
      await sanctions.ban(target.id, typeof body.reason === "string" && body.reason ? body.reason.slice(0, 200) : "admin decision", user.id);
      return sendJson(res, 200, { ok: true }), true;
    }
    if (action === "unban") return await sanctions.unban(target.id), sendJson(res, 200, { ok: true }), true;
    if (action === "unflag") return await sql.unflag.run(target.id), sendJson(res, 200, { ok: true }), true;
    if (action === "cancel-wins") return sendJson(res, 200, { cancelled: await online.cancelWins(target.id) }), true;
    return false;
  };
}
