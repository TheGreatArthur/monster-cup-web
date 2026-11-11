// Gifts from the admins, delivered through the game's own mail (docs/mail_and_save_analysis.md).
// An admin queues a gift (/admin/gifts); the play page (public/gifts.js) asks for the account's
// pending gifts, makes the game send one as a mail from the Digital Arena and reports it
// delivered once the player opened the mail (the game hands the gift over at that moment).
//
// Kinds: bits, item (item table index + quantity), digimon (species, with optional bonus stats),
// mail (one of the game's own 201 mails, by catalogue index). The first three reuse catalogue mail
// 108 ("Congratulations! Here's a gift from me.") with gift definition 12, both rewritten in RAM for
// the delivery. The game gives a Digimon its usual stats; the page then adds the bonus in RAM.
export const MAX_BITS = 9_999_999;   // the game caps the player's bits there
export const GIFT_MAIL = 108, GIFT_DEF = 12, ARENA = 0;
const ITEM_COUNT = 118, SPECIES_FIRST = 8, SPECIES_LAST = 227, MAIL_COUNT = 201, MAX_QTY = 99;
// Gift definitions: {type, 0, 1, result text (mail_text), param, param2, 0}.
const BITS_TEXT = 213, DIGIMON_TEXT = 216;
const ITEM_TEXT = { 1: 202, 3: 203, 2: 204 };   // Protein, Medicine, Bandage; others "You got an item."
const OTHER_ITEM_TEXT = 205;
const FOOD_ITEM = 0;   // the game's item mail does nothing for it: the play page adds it (public/gifts.js)
const LIST_SIZE = 100;
// Bonus of HP, TP, Attack, Defense, Wisdom, Speed: at most what the save's bit fields hold.
export const MAX_BONUS = [8191, 511, 511, 511, 511, 511];

// The gifts table (web/db/schema.sql): bonus is a JSON array in MAX_BONUS order; bonus_seen: a save
// already showed those stats (save-check.js).
export function createGifts(db, mails = []) {
  const sql = {
    insert: db.prepare(`INSERT INTO gifts (user_id, kind, value, qty, bonus, note, by_admin, bank_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
    // A gift bringing a banked Digimon back carries its struct (bank.js).
    pending: db.prepare(`SELECT g.id, g.kind, g.value, g.qty, g.bonus, g.bank_id,
        replace(encode(b.struct, 'base64'), chr(10), '') AS struct
      FROM gifts g LEFT JOIN bank b ON b.id = g.bank_id WHERE g.user_id = ? AND g.status = 'pending' ORDER BY g.id`),
    unseen: db.prepare(`SELECT id, value AS species, bonus FROM gifts
      WHERE user_id = ? AND status = 'delivered' AND bonus IS NOT NULL AND bonus_seen = 0 ORDER BY id`),
    seen: db.prepare("UPDATE gifts SET bonus_seen = 1 WHERE id = ?"),
    delivered: db.prepare(`UPDATE gifts SET status = 'delivered', delivered_at = game.utc_text()
      WHERE id = ? AND user_id = ? AND status = 'pending'`),
    cancel: db.prepare("UPDATE gifts SET status = 'cancelled' WHERE id = ? AND status = 'pending'"),
    history: db.prepare(`SELECT g.id, u.id AS player_id, u.username AS player, g.kind, g.value, g.qty, g.bonus, g.note, g.status,
        a.username AS admin, g.created_at AS created, g.delivered_at AS delivered
      FROM gifts g JOIN users u ON u.id = g.user_id LEFT JOIN users a ON a.id = g.by_admin
      ORDER BY g.id DESC LIMIT ${LIST_SIZE}`),
    forUser: db.prepare(`SELECT g.id, g.kind, g.value, g.qty, g.bonus, g.note, g.status, a.username AS admin,
        g.created_at AS created, g.delivered_at AS delivered
      FROM gifts g LEFT JOIN users a ON a.id = g.by_admin WHERE g.user_id = ? ORDER BY g.id DESC LIMIT ${LIST_SIZE}`),
  };
  const int = (v) => (Number.isInteger(v) ? v : NaN);

  const withBonus = (g) => ({ ...g, bonus: g.bonus && JSON.parse(g.bonus) });

  // The checked gift, or an error message.
  function validate({ kind, value, qty = 1, bonus }) {
    value = int(value); qty = int(qty);
    if (kind === "bits") return value >= 1 && value <= MAX_BITS ? { kind, value, qty: 1 } : "Amount must be between 1 and 9,999,999.";
    if (kind === "item") {
      if (!(value >= 0 && value < ITEM_COUNT)) return "Unknown item.";
      return qty >= 1 && qty <= MAX_QTY ? { kind, value, qty } : "Quantity must be between 1 and 99.";
    }
    if (kind === "digimon") {
      if (!(value >= SPECIES_FIRST && value <= SPECIES_LAST)) return "Unknown species.";
      if (bonus === undefined) return { kind, value, qty: 1 };
      if (!Array.isArray(bonus) || bonus.length !== MAX_BONUS.length
        || !bonus.every((b, k) => Number.isInteger(b) && b >= 0 && b <= MAX_BONUS[k])) return "Invalid bonus stats.";
      return { kind, value, qty: 1, bonus: bonus.some((b) => b > 0) ? bonus : undefined };
    }
    if (kind === "mail") return mails[value]?.giftable ? { kind, value, qty: 1 } : "This mail has no gift.";
    return "Unknown gift type.";
  }

  // What the page writes in RAM for a gift: the mail to send and, for a custom gift, the sender
  // and gift definition to put in its catalogue record.
  function plan({ id, kind, value, qty, bonus, bank_id: bankId, struct }) {
    if (kind === "mail") return { id, mail: value };
    let def;
    if (kind === "bits") def = [4, 0, 1, BITS_TEXT, value, 0, 0];
    else if (kind === "item") def = [3, 0, 1, ITEM_TEXT[value] ?? OTHER_ITEM_TEXT, value, qty, 0];
    else def = [2, 0, 1, DIGIMON_TEXT, value, 0, 0];
    return { id, mail: GIFT_MAIL, sender: ARENA, defIndex: GIFT_DEF, def,
      ...(bonus && { species: value, bonus: JSON.parse(bonus) }),
      ...(bankId && struct && { species: value, bank: { id: bankId, struct } }),
      ...(kind === "item" && value === FOOD_ITEM && { food: qty }) };
  }

  return {
    validate,
    create: async (userId, gift, note, adminId, bankId = null) => (await sql.insert.run(userId, gift.kind, gift.value, gift.qty,
      gift.bonus ? JSON.stringify(gift.bonus) : null, note || null, adminId, bankId)).id,
    cancel: async (id) => (await sql.cancel.run(id)).changes > 0,
    history: async () => (await sql.history.all()).map(withBonus),
    forUser: async (userId) => (await sql.forUser.all(userId)).map(withBonus),
    // Delivered Digimon whose bonus no save showed yet (save-check.js checkSave), then their marking.
    unseenBonuses: async (userId) => (await sql.unseen.all(userId)).map(withBonus),
    bonusSeen: (id) => sql.seen.run(id),
    pending: async (userId) => (await sql.pending.all(userId)).map(plan),
    delivered: async (userId, id) => (await sql.delivered.run(id, userId)).changes > 0,
  };
}
