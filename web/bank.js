// The Digimon bank (table bank, web/db/schema.sql) and the trades between banks (table trades).
//
// Deposit: the play page (public/bank.js) sends the game's struct of a farm Digimon (0x1D0 bytes,
// docs/mail_and_save_analysis.md 2.5), then turns its farm record off in RAM. The game saves only
// the records that are on (ARM9 0x02068e6c copies the record's first word into the slot's "used"
// bit), so the Digimon leaves the save at the game's next save. The deposit must match a Digimon of
// the last uploaded save (same name, stats the anti-cheat accepts from there). It stays 'pending'
// until a save shows it gone: a save with as many Digimon of that name as before means the game
// still has it (an old session, the page closed before the game saved), so the deposit is undone
// ('returned') instead of letting the Digimon exist twice.
//
// Withdraw: a gift (gifts.js) brings a Digimon of the species by mail, then the page writes the
// banked struct over the new record (keeping the game's cage). The row is 'out' until a save
// shows the Digimon; a page that closed before the game saved gets it again at its next start.
// The anti-cheat (save-check.js) accepts its stats like an admin's bonus.
//
// Trades: a player offers one of their stored Digimon for one of another player's ('direct'), or
// for a Digimon listed on the public board ('bid'). Accepting swaps the owners in one statement.
import { checkSave } from "./save-check.js";

export const STRUCT_SIZE = 0x1d0;
const S_SPECIES = 0, S_NAME = 0x2c, NAME_CHARS = 9, S_STATS = 0x58;
const EGG = 0;
const MAX_ACTIVE = 40;              // banked Digimon per player, all states but the final ones
const BOARD_SIZE = 60;
const ACTIVE = "('pending', 'stored', 'event', 'withdrawing', 'out')";

// Species, name (UTF-16 codes, as save-check.js readDigimon gives them) and the 8 stats of a struct.
export function readStruct(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const name = Array.from({ length: NAME_CHARS }, (_, k) => view.getUint16(S_NAME + k * 2, true));
  return { species: view.getUint32(S_SPECIES, true), name,
    stats: Array.from({ length: 8 }, (_, k) => view.getUint32(S_STATS + k * 4, true)) };
}
const nameText = (codes) => String.fromCharCode(...codes.filter((c) => c));
const sameName = (a, b) => a.length === b.length && a.every((c, k) => c === b[k]);

export function createBank({ db, readJson, sendJson, gameInfo, gameTables, gifts, flagged }) {
  const sql = {
    lastSave: db.prepare("SELECT at, digimon FROM save_history WHERE user_id = ? ORDER BY id DESC LIMIT 1"),
    activeCount: db.prepare(`SELECT COUNT(*) AS n FROM bank WHERE user_id = ? AND status IN ${ACTIVE}`),
    pendingName: db.prepare("SELECT 1 FROM bank WHERE user_id = ? AND status = 'pending' AND name = ?"),
    insert: db.prepare(`INSERT INTO bank (user_id, species, name, stats, struct, name_count, first_owner)
      VALUES (?, ?, ?, ?, ?, ?, $1) RETURNING id`),
    mine: db.prepare(`SELECT b.id, b.user_id, b.species, b.name, b.stats, b.status, b.listed, b.event_id, b.created_at,
        e.title AS event FROM bank b LEFT JOIN events e ON e.id = b.event_id
      WHERE b.user_id = ? AND (b.status IN ${ACTIVE}) ORDER BY b.id DESC`),
    byStatus: db.prepare("SELECT id, species, name, stats, name_count, gift_id FROM bank WHERE user_id = ? AND status = ?"),
    setStatus: db.prepare("UPDATE bank SET status = ?, updated_at = game.utc_text() WHERE id = ? AND status = ?"),
    row: db.prepare("SELECT id, user_id, species, name, stats, status, listed FROM bank WHERE id = ?"),
    toWithdraw: db.prepare(`UPDATE bank SET status = 'withdrawing', listed = false, updated_at = game.utc_text()
      WHERE id = ? AND user_id = ? AND status = 'stored' RETURNING id, species, name`),
    setGift: db.prepare("UPDATE bank SET gift_id = ? WHERE id = ?"),
    deliveredGifts: db.prepare(`SELECT b.id, b.species, b.name FROM bank b JOIN gifts g ON g.id = b.gift_id
      WHERE b.user_id = ? AND b.status = 'withdrawing' AND g.status = 'delivered'`),
    outRows: db.prepare("SELECT id, species, name FROM bank WHERE user_id = ? AND status = 'out'"),
    reWithdraw: db.prepare("UPDATE bank SET status = 'withdrawing', updated_at = game.utc_text() WHERE id = ?"),
    applied: db.prepare(`UPDATE bank SET status = 'out', updated_at = game.utc_text()
      WHERE id = ? AND user_id = ? AND status = 'withdrawing'`),
    list: db.prepare("UPDATE bank SET listed = ? WHERE id = ? AND user_id = ? AND status = 'stored'"),
    exempt: db.prepare("SELECT id, species, stats FROM bank WHERE user_id = ? AND status IN ('withdrawing', 'out')"),
    userByName: db.prepare(`SELECT id, COALESCE(display_name, username) AS name FROM users
      WHERE lower(username) = lower(?) OR lower(display_name) = lower(?) ORDER BY id LIMIT 1`),
    storedOf: db.prepare(`SELECT id, species, name, stats, listed FROM bank WHERE user_id = ? AND status = 'stored'
      ORDER BY id DESC`),
    board: db.prepare(`SELECT b.id, b.user_id, b.species, b.name, b.stats, COALESCE(u.display_name, u.username) AS owner
      FROM bank b JOIN users u ON u.id = b.user_id
      WHERE b.listed AND b.status = 'stored' ORDER BY b.updated_at DESC LIMIT ${BOARD_SIZE}`),
    trades: db.prepare(`SELECT t.id, t.kind, t.from_user, t.to_user, t.give_id, t.take_id, t.created_at,
        COALESCE(f.display_name, f.username) AS from_name, COALESCE(o.display_name, o.username) AS to_name,
        g.species AS give_species, g.name AS give_name, g.stats AS give_stats,
        k.species AS take_species, k.name AS take_name, k.stats AS take_stats
      FROM trades t JOIN users f ON f.id = t.from_user JOIN users o ON o.id = t.to_user
      JOIN bank g ON g.id = t.give_id JOIN bank k ON k.id = t.take_id
      WHERE t.status = 'open' AND (t.from_user = ? OR t.to_user = ?) ORDER BY t.id DESC`),
    openTrade: db.prepare("SELECT 1 FROM trades WHERE status = 'open' AND from_user = ? AND give_id = ? AND take_id = ?"),
    insertTrade: db.prepare("INSERT INTO trades (kind, from_user, to_user, give_id, take_id) VALUES (?, ?, ?, ?, ?) RETURNING id"),
    // Both Digimon still stored with their owners: the trade is accepted and the owners swap, all
    // in one statement.
    accept: db.prepare(`WITH t AS (
        UPDATE trades SET status = 'accepted', decided_at = game.utc_text()
        WHERE id = ?::bigint AND to_user = ?::bigint AND status = 'open'
          AND EXISTS (SELECT 1 FROM bank WHERE id = trades.give_id AND user_id = trades.from_user AND status = 'stored')
          AND EXISTS (SELECT 1 FROM bank WHERE id = trades.take_id AND user_id = trades.to_user AND status = 'stored')
        RETURNING from_user, to_user, give_id, take_id),
      swapped AS (
        UPDATE bank SET user_id = CASE WHEN bank.id = t.give_id THEN t.to_user ELSE t.from_user END,
          listed = false, updated_at = game.utc_text()
        FROM t WHERE bank.id IN (t.give_id, t.take_id) RETURNING bank.id)
      SELECT give_id, take_id, (SELECT COUNT(*) FROM swapped) AS n FROM t`),
    // Other open trades about a Digimon that changed hands or left the bank.
    closeTrades: db.prepare(`UPDATE trades SET status = 'cancelled', decided_at = game.utc_text()
      WHERE status = 'open' AND (give_id = ANY(?::bigint[]) OR take_id = ANY($1::bigint[]))`),
    decide: db.prepare(`UPDATE trades SET status = ?, decided_at = game.utc_text()
      WHERE id = ? AND status = 'open' AND (CASE WHEN $1 = 'declined' THEN to_user ELSE from_user END) = ?`),
    peek: db.prepare("SELECT id, species, name, stats FROM bank WHERE id = ? AND user_id = ? AND status = 'stored'"),
    releaseEvent: db.prepare(`UPDATE bank SET status = 'stored', event_id = NULL, updated_at = game.utc_text()
      WHERE event_id = ? AND status = 'event'`),
    forEvent: db.prepare(`UPDATE bank SET status = 'event', event_id = ?, listed = false, updated_at = game.utc_text()
      WHERE id = ? AND user_id = ? AND status = 'stored' RETURNING id, species, name, stats`),
  };

  const species = new Map(gameInfo.species.map((s) => [s.id, s]));
  const speciesNames = Object.fromEntries(gameInfo.species.map((s) => [s.id, s.name]));
  const summary = (r) => {
    const s = species.get(r.species);
    return { id: r.id, species: r.species, speciesName: s?.name ?? `#${r.species}`, level: s?.level ?? "",
      name: r.name, stats: typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats };
  };
  const tradeView = (t) => ({ id: t.id, kind: t.kind, from: { id: t.from_user, name: t.from_name },
    to: { id: t.to_user, name: t.to_name }, created: t.created_at,
    give: summary({ id: t.give_id, species: t.give_species, name: t.give_name, stats: t.give_stats }),
    take: summary({ id: t.take_id, species: t.take_species, name: t.take_name, stats: t.take_stats }) });

  // A deposit, checked against the last save; the row's id, or an error message.
  async function deposit(userId, base64) {
    if (typeof base64 !== "string") return "No Digimon sent.";
    const buf = Buffer.from(base64, "base64");
    if (buf.length !== STRUCT_SIZE) return "This is not a Digimon record.";
    if (await flagged(userId)) return "Your save is under review: the bank is closed for now.";
    const d = readStruct(buf);
    if (d.species === EGG || !gameTables?.species.has(d.species)) return "Eggs cannot go to the bank.";
    if ((await sql.activeCount.get(userId)).n >= MAX_ACTIVE) return `Your bank is full (${MAX_ACTIVE} Digimon).`;
    const name = nameText(d.name);
    if (await sql.pendingName.get(userId, name)) return `A Digimon named ${name} is already on its way to the bank.`;
    const last = await sql.lastSave.get(userId);
    const saved = last?.digimon ? JSON.parse(last.digimon) : null;
    const twins = (saved ?? []).filter((p) => p.species !== EGG && sameName(p.name, d.name));
    if (!twins.length) {
      return "Only a Digimon of your saved game can go to the bank: the game saves at the end of each day.";
    }
    const candidate = { slot: -1, species: d.species, name: d.name, stats: d.stats };
    if (checkSave([candidate], saved, Date.now() - last.at, gameTables).length) {
      return "This Digimon does not match your saved game.";
    }
    return (await sql.insert.run(userId, d.species, name, JSON.stringify(d.stats), buf, twins.length)).id;
  }

  async function withdraw(userId, id) {
    const row = await sql.toWithdraw.get(id, userId);
    if (!row) return null;
    await sql.closeTrades.run([id]);
    const gift = await gifts.create(userId, { kind: "digimon", value: row.species, qty: 1 }, `Bank: ${row.name}`, null, id);
    await sql.setGift.run(gift, id);
    return gift;
  }

  // A new page session: what the game lost because the page closed before it saved comes again.
  async function resume(userId) {
    const again = [...await sql.deliveredGifts.all(userId), ...await sql.outRows.all(userId)];
    for (const row of again) {
      await sql.reWithdraw.run(row.id);
      const gift = await gifts.create(userId, { kind: "digimon", value: row.species, qty: 1 }, `Bank: ${row.name}`, null, row.id);
      await sql.setGift.run(gift, row.id);
    }
    return again.length;
  }

  return {
    peek: async (userId, id) => {
      const row = await sql.peek.get(id, userId);
      return row && summary(row);
    },
    releaseEvent: (eventId) => sql.releaseEvent.run(eventId),
    takeForEvent: async (userId, bankId, eventId) => {
      const row = await sql.forEvent.get(eventId, bankId, userId);
      if (row) await sql.closeTrades.run([bankId]);
      return row && summary(row);
    },
    summary,

    // After each uploaded save (server.js recordSave): deposits the game no longer has are stored,
    // or undone if it still has them; withdrawn Digimon the save shows are back for good.
    async onSave(userId, digimon) {
      if (!digimon) return;
      for (const row of await sql.byStatus.all(userId, "pending")) {
        const count = digimon.filter((d) => d.species !== EGG && nameText(d.name) === row.name).length;
        await sql.setStatus.run(count < row.name_count ? "stored" : "returned", row.id, "pending");
      }
      for (const row of await sql.byStatus.all(userId, "out")) {
        const stats = JSON.parse(row.stats);
        if (digimon.some((d) => d.species === row.species && nameText(d.name) === row.name
          && d.stats.slice(2).every((v, k) => v >= stats[k + 2]))) {
          await sql.setStatus.run("withdrawn", row.id, "out");
        }
      }
    },

    // Banked Digimon on their way back: the anti-cheat takes their stats as a gift's bonus.
    async exemptions(userId) {
      return (await sql.exempt.all(userId)).map((r) => {
        const stats = JSON.parse(r.stats), base = species.get(r.species)?.base ?? [];
        return { id: `bank:${r.id}`, species: r.species, bonus: base.map((b, k) => Math.max(0, stats[k + 2] - b)) };
      });
    },

    // /api/bank/...
    async handle(route, req, res, user, url) {
      if (route === "GET /api/bank") {
        const trades = (await sql.trades.all(user.id, user.id)).map(tradeView);
        return sendJson(res, 200, {
          rows: (await sql.mine.all(user.id)).map((r) => ({ ...summary(r), status: r.status, listed: r.listed, event: r.event })),
          incoming: trades.filter((t) => t.to.id === user.id), outgoing: trades.filter((t) => t.from.id === user.id),
          board: (await sql.board.all()).filter((r) => r.user_id !== user.id)
            .map((r) => ({ ...summary(r), owner: { id: r.user_id, name: r.owner } })),
          speciesNames,
        }), true;
      }
      if (route === "GET /api/bank/player") {
        const name = (url.searchParams.get("name") ?? "").trim();
        const other = name && await sql.userByName.get(name, name);
        if (!other || other.id === user.id) return sendJson(res, 404, { error: "No other player with this name." }), true;
        return sendJson(res, 200, { player: other, rows: (await sql.storedOf.all(other.id)).map(summary) }), true;
      }
      if (req.method !== "POST" || !url.pathname.startsWith("/api/bank/")) return false;
      const body = await readJson(req);
      const action = url.pathname.slice("/api/bank/".length);
      const id = Number.isInteger(body.id) ? body.id : -1;
      if (action === "deposit") {
        const result = await deposit(user.id, body.struct);
        return sendJson(res, typeof result === "string" ? 400 : 200, typeof result === "string" ? { error: result } : { id: result }), true;
      }
      if (action === "resume") return sendJson(res, 200, { again: await resume(user.id) }), true;
      if (action === "withdraw") {
        const gift = await withdraw(user.id, id);
        return sendJson(res, gift ? 200 : 409, gift ? { gift } : { error: "This Digimon cannot leave the bank now." }), true;
      }
      if (action === "applied") return sendJson(res, 200, { ok: (await sql.applied.run(id, user.id)).changes > 0 }), true;
      if (action === "list") {
        const ok = (await sql.list.run(body.listed === true, id, user.id)).changes > 0;
        if (ok && body.listed !== true) await sql.closeTrades.run([id]);
        return sendJson(res, ok ? 200 : 409, ok ? { ok } : { error: "Only a stored Digimon can go on the board." }), true;
      }
      if (action === "trade") {
        const give = await sql.row.get(Number.isInteger(body.give) ? body.give : -1);
        const take = await sql.row.get(Number.isInteger(body.take) ? body.take : -1);
        if (give?.user_id !== user.id || give.status !== "stored") return sendJson(res, 409, { error: "Pick one of your stored Digimon." }), true;
        if (!take || take.user_id === user.id || take.status !== "stored") return sendJson(res, 409, { error: "That Digimon is not available." }), true;
        if (await sql.openTrade.get(user.id, give.id, take.id)) return sendJson(res, 409, { error: "You already offered this trade." }), true;
        const trade = await sql.insertTrade.run(take.listed ? "bid" : "direct", user.id, take.user_id, give.id, take.id);
        return sendJson(res, 200, { id: trade.id }), true;
      }
      if (action === "accept") {
        const done = await sql.accept.get(id, user.id);
        if (!done?.n) return sendJson(res, 409, { error: "This trade is no longer possible." }), true;
        await sql.closeTrades.run([done.give_id, done.take_id]);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (action === "decline" || action === "cancel") {
        const ok = (await sql.decide.run(action === "decline" ? "declined" : "cancelled", id, user.id)).changes > 0;
        return sendJson(res, 200, { ok }), true;
      }
      return false;
    },
  };
}
