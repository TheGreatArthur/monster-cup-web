// Anti-cheat, step 4 (docs/anti_cheat_strategy.md, "Sanctions et réputation" and R7): a trust
// score per account from its recent incidents, an automatic ban from ranked play past a
// threshold (solo play and friendly rooms stay open), and who may play ranked at all.
const START_RATING = 1000;
// Points per incident (online.js, referee verdicts), counted over TRUST_DAYS. A flagged save
// (save-check.js) counts SAVE_FLAG_POINTS.
const POINTS = { cancel: 1, disputed: 1, forfeit: 2, timeout: 2, protocol: 3, team: 5, lied: 10, tampered: 20 };
const SAVE_FLAG_POINTS = 20;
const TRUST_DAYS = 30;
const BAN_POINTS = Number(process.env.RANKED_BAN_POINTS ?? 30);
// A new account waits this long before its first ranked match (multi-account farming).
const MIN_AGE_HOURS = Number(process.env.RANKED_MIN_AGE_HOURS ?? 24);

// ranked_bans (web/db/schema.sql): by_admin null = automatic.
export function createSanctions(db) {
  const cases = Object.entries(POINTS).map(([kind, points]) => `WHEN '${kind}' THEN ${points}`).join(" ");
  const sql = {
    points: db.prepare(`SELECT COALESCE(SUM(CASE kind ${cases} ELSE 0 END), 0) AS points
      FROM online_incidents WHERE user_id = ? AND at >= game.utc_text(interval '-${TRUST_DAYS} days')`),
    flagged: db.prepare("SELECT 1 FROM save_flags WHERE user_id = ?"),
    ban: db.prepare("INSERT INTO ranked_bans (user_id, reason, by_admin) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
    unban: db.prepare("DELETE FROM ranked_bans WHERE user_id = ?"),
    banned: db.prepare("SELECT at, reason, by_admin FROM ranked_bans WHERE user_id = ?"),
    resetRating: db.prepare(`UPDATE ratings SET rating = ${START_RATING} WHERE user_id = ?`),
    age: db.prepare(`SELECT (EXTRACT(EPOCH FROM (now() AT TIME ZONE 'utc') - created_at::timestamp) / 3600)::float8 AS hours
      FROM users WHERE id = ?`),
  };

  // Higher is worse.
  async function score(userId) {
    return (await sql.points.get(userId)).points + (await sql.flagged.get(userId) ? SAVE_FLAG_POINTS : 0);
  }

  // Bars the account from ranked play and resets its rating.
  async function ban(userId, reason, adminId = null) {
    if (await sql.banned.get(userId)) return;
    await sql.ban.run(userId, reason, adminId);
    await sql.resetRating.run(userId);
  }

  // After each new incident or flag: past the threshold, the ban is automatic.
  async function review(userId) {
    const points = await score(userId);
    if (points >= BAN_POINTS) await ban(userId, `score de confiance ${points} ≥ ${BAN_POINTS}`);
  }

  // Why the account may not play ranked ({ reason, error }: a code for the game, a text for the page), or null.
  async function rankedRefusal(userId) {
    const banned = await sql.banned.get(userId);
    if (banned) {
      return { reason: "ranked_banned", error: `Tu es suspendu du classé (${banned.reason}). Les rooms amicales restent possibles.` };
    }
    if (await sql.flagged.get(userId)) {
      return { reason: "ranked_flagged", error: "Ta sauvegarde a été signalée : le classé t'est fermé (les rooms amicales restent possibles)." };
    }
    const hours = (await sql.age.get(userId))?.hours ?? 0;
    if (hours < MIN_AGE_HOURS) {
      return { reason: "ranked_too_new", error: `Le classé s'ouvre ${MIN_AGE_HOURS} h après la création du compte `
        + `(encore ${Math.ceil(MIN_AGE_HOURS - hours)} h). Les rooms amicales sont déjà ouvertes.` };
    }
    return null;
  }

  return {
    score, ban, review, rankedRefusal, banned: async (userId) => (await sql.banned.get(userId)) ?? null,
    unban: (userId) => sql.unban.run(userId), POINTS, SAVE_FLAG_POINTS, BAN_POINTS, TRUST_DAYS,
  };
}
