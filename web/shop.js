// PvP coins and the shop (tables wallets, coin_log and shop_items, web/db/schema.sql).
//
// Every online battle won against another player pays WIN_COINS, ranked or in a private room.
// Against one same opponent only the first WINS_PER_OPPONENT wins of the last day pay, so two
// accounts cannot farm coins off each other. When the referee or an admin takes a win back
// (online.js applyVerdict / cancelWins), its coins go back too, without going below zero. Events
// pay their winners through grant() (events.js).
//
// The shop's catalogue is edited on /admin/shop: Digimon (with optional bonus stats) and the
// game's items, each with a price, a discount (until an optional end) and an optional stock. A
// purchase is one SQL statement (no half done purchase): it takes the coins only if the balance
// covers the price and the stock is not out, and queues the goods as a gift (gifts.js), which the
// play page then delivers through the game's mail like an admin's gift.
const WIN_COINS = 5;
const WINS_PER_OPPONENT = Number(process.env.COINS_WINS_PER_OPPONENT ?? 5);
const MAX_PRICE = 1_000_000, MAX_SORT = 9999;

const utcText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
};

export function createShop({ db, readJson, sendJson, gameInfo, gifts }) {
  // The discount that applies now, and the price it gives (SQL, for the purchase itself).
  const DISCOUNT_NOW = "(CASE WHEN sale_ends IS NULL OR sale_ends > game.utc_text() THEN discount ELSE 0 END)";
  const COST = `((price * (100 - ${DISCOUNT_NOW}) + 50) / 100)`;
  const sql = {
    balance: db.prepare("SELECT coins FROM wallets WHERE user_id = ?"),
    ensureWallet: db.prepare("INSERT INTO wallets (user_id) VALUES (?) ON CONFLICT DO NOTHING"),
    // The win's row and the balance, in one statement. Nothing is paid past the opponent's cap or
    // twice for one match (unique index coin_log_match).
    award: db.prepare(`WITH paid AS (
        INSERT INTO coin_log (user_id, delta, reason, match_id, opponent_id)
        SELECT ?::bigint, ?::int, 'win', ?::bigint, ?::bigint
        WHERE (SELECT COUNT(*) FROM coin_log WHERE user_id = $1 AND opponent_id = $4 AND reason = 'win'
               AND created_at >= game.utc_text(interval '-1 day')) < ?
        ON CONFLICT DO NOTHING RETURNING delta)
      INSERT INTO wallets (user_id, coins) SELECT $1, delta FROM paid
      ON CONFLICT (user_id) DO UPDATE SET coins = wallets.coins + EXCLUDED.coins RETURNING coins`),
    revoke: db.prepare(`WITH taken AS (
        UPDATE coin_log SET reason = 'revoked' WHERE match_id = ? AND user_id = ? AND reason = 'win' RETURNING delta)
      UPDATE wallets SET coins = GREATEST(0, coins - (SELECT SUM(delta) FROM taken))
      WHERE user_id = $2 AND EXISTS (SELECT 1 FROM taken) RETURNING coins`),
    grant: db.prepare(`WITH logged AS (
        INSERT INTO coin_log (user_id, delta, reason, event_id) VALUES (?::bigint, ?::int, ?, ?::bigint) RETURNING delta)
      INSERT INTO wallets (user_id, coins) SELECT $1, delta FROM logged
      ON CONFLICT (user_id) DO UPDATE SET coins = wallets.coins + EXCLUDED.coins RETURNING coins`),
    offers: db.prepare(`SELECT id, kind, value, qty, bonus, price, discount, sale_ends, stock, sold, active, sort,
        ${DISCOUNT_NOW} AS discount_now, ${COST} AS cost
      FROM shop_items ORDER BY sort, id`),
    buy: db.prepare(`WITH it AS (
        SELECT id, kind, value, qty, bonus, ${COST} AS cost FROM shop_items
        WHERE id = ?::bigint AND active AND (stock IS NULL OR stock > 0)),
      paid AS (
        UPDATE wallets w SET coins = w.coins - it.cost FROM it WHERE w.user_id = ?::bigint AND w.coins >= it.cost
        RETURNING w.coins, it.id, it.kind, it.value, it.qty, it.bonus, it.cost),
      sold AS (
        UPDATE shop_items s SET sold = s.sold + 1, stock = s.stock - 1 FROM paid WHERE s.id = paid.id),
      gift AS (
        INSERT INTO gifts (user_id, kind, value, qty, bonus, note) SELECT $2, kind, value, qty, bonus, ? FROM paid RETURNING id),
      logged AS (
        INSERT INTO coin_log (user_id, delta, reason, gift_id, shop_item_id) SELECT $2, -paid.cost, 'shop', gift.id, paid.id
        FROM paid, gift)
      SELECT (SELECT coins FROM paid) AS coins, (SELECT id FROM gift) AS gift, (SELECT cost FROM it) AS cost`),
    insert: db.prepare(`INSERT INTO shop_items (kind, value, qty, bonus, price, discount, sale_ends, stock, active, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
    update: db.prepare(`UPDATE shop_items SET kind = ?, value = ?, qty = ?, bonus = ?, price = ?, discount = ?,
      sale_ends = ?, stock = ?, active = ?, sort = ? WHERE id = ?`),
    remove: db.prepare("DELETE FROM shop_items WHERE id = ?"),
  };

  const balance = async (userId) => (await sql.balance.get(userId))?.coins ?? 0;
  const species = new Map(gameInfo.species.map((s) => [s.id, s]));

  // What the pages show of an offer: its name and, for a Digimon, its level, attribute and the
  // stats it arrives with (its species' base plus the bonus).
  function describe(row, admin = false) {
    const bonus = row.bonus ? JSON.parse(row.bonus) : null;
    const out = { id: row.id, kind: row.kind, value: row.value, qty: row.qty, price: row.price, cost: row.cost,
      discount: row.discount_now, saleEnds: row.discount_now ? row.sale_ends : null,
      stock: row.stock, soldOut: row.stock === 0 };
    if (row.kind === "digimon") {
      const s = species.get(row.value);
      Object.assign(out, { name: s?.name ?? `#${row.value}`, level: s?.level ?? "", attribute: s?.attribute ?? "",
        types: s?.types ?? [], bonus, stats: (s?.base ?? []).map((b, k) => b + (bonus?.[k] ?? 0)) });
    } else {
      const item = gameInfo.items[row.value];
      Object.assign(out, { name: item?.name ?? `item ${row.value}`, category: item?.category ?? "" });
    }
    if (admin) Object.assign(out, { discountSet: row.discount, saleEndsSet: row.sale_ends, sold: row.sold,
      active: row.active, sort: row.sort });
    return out;
  }

  // An offer from the admin page, checked; or an error message.
  function validOffer(body) {
    const gift = gifts.validate({ kind: body.kind, value: body.value, qty: body.qty ?? 1, bonus: body.bonus });
    if (typeof gift === "string") return gift;
    if (gift.kind !== "digimon" && gift.kind !== "item") return "The shop sells Digimon and items.";
    const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    if (!int(body.price, 0, MAX_PRICE)) return "Price must be between 0 and 1,000,000 coins.";
    if (!int(body.discount ?? 0, 0, 100)) return "Discount must be between 0 and 100 %.";
    if (body.stock != null && !int(body.stock, 0, 1_000_000)) return "Stock must be a whole number.";
    const saleEnds = body.saleEnds ? utcText(body.saleEnds) : null;
    if (body.saleEnds && !saleEnds) return "Invalid sale end.";
    return { ...gift, bonus: gift.bonus ? JSON.stringify(gift.bonus) : null, price: body.price,
      discount: body.discount ?? 0, saleEnds, stock: body.stock ?? null, active: body.active !== false,
      sort: int(body.sort, 0, MAX_SORT) ? body.sort : 0 };
  }

  return {
    winCoins: WIN_COINS,
    balance,
    // A won online battle (online.js settle / applyVerdict). Returns the new balance, or
    // undefined when the win does not pay (cap reached, already paid).
    award: async (matchId, winner, loser) => (await sql.award.get(winner, WIN_COINS, matchId, loser, WINS_PER_OPPONENT))?.coins,
    revoke: async (matchId, userId) => (await sql.revoke.get(matchId, userId))?.coins,
    // Coins from an event (events.js). Returns the new balance.
    grant: async (userId, coins, reason, eventId = null) => (await sql.grant.get(userId, coins, reason, eventId))?.coins,

    // GET /api/shop, POST /api/shop/buy { id }.
    async handle(route, req, res, user) {
      if (route === "GET /api/shop") {
        const offers = (await sql.offers.all()).filter((r) => r.active).map((r) => describe(r));
        return sendJson(res, 200, { coins: await balance(user.id), winCoins: WIN_COINS, statLabels: gameInfo.statLabels,
          offers }), true;
      }
      if (route === "POST /api/shop/buy") {
        const { id } = await readJson(req);
        const offer = (await sql.offers.all()).find((r) => r.id === id && r.active);
        if (!offer) return sendJson(res, 404, { error: "This offer is gone." }), true;
        if (offer.stock === 0) return sendJson(res, 409, { error: "Sold out." }), true;
        const { name } = describe(offer);
        await sql.ensureWallet.run(user.id);
        let row;
        try {
          row = await sql.buy.get(id, user.id, `Shop: ${offer.kind === "item" && offer.qty > 1 ? `${offer.qty} x ` : ""}${name}`);
        } catch (err) {
          if (/stock/.test(err.message)) return sendJson(res, 409, { error: "Sold out." }), true;
          throw err;
        }
        if (!row?.gift) return sendJson(res, 409, { error: "Not enough coins.", coins: await balance(user.id) }), true;
        return sendJson(res, 200, { coins: row.coins, gift: row.gift, name, kind: offer.kind }), true;
      }
      return false;
    },

    // /api/admin/shop (admin.js checks the admin first): GET the catalogue, POST save / delete.
    async handleAdmin(route, req, res) {
      if (route === "GET /api/admin/shop") {
        return sendJson(res, 200, { offers: (await sql.offers.all()).map((r) => describe(r, true)) }), true;
      }
      if (route === "POST /api/admin/shop/save") {
        const body = await readJson(req);
        const offer = validOffer(body);
        if (typeof offer === "string") return sendJson(res, 400, { error: offer }), true;
        const values = [offer.kind, offer.value, offer.qty, offer.bonus, offer.price, offer.discount, offer.saleEnds,
          offer.stock, offer.active, offer.sort];
        if (Number.isInteger(body.id)) {
          const { changes } = await sql.update.run(...values, body.id);
          return sendJson(res, changes ? 200 : 404, changes ? { id: body.id } : { error: "Unknown offer." }), true;
        }
        return sendJson(res, 200, { id: (await sql.insert.run(...values)).id }), true;
      }
      if (route === "POST /api/admin/shop/delete") {
        const { id } = await readJson(req);
        return sendJson(res, 200, { ok: Number.isInteger(id) && (await sql.remove.run(id)).changes > 0 }), true;
      }
      return false;
    },
  };
}
