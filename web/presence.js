// Who is playing right now, for the admins' live page (/admin/players). The play page reports
// every few seconds (public/play.js): whether the game runs, whether its tab is visible and where
// a gift's mail stands. An account is online while its reports keep coming; the last one is
// kept in the database, so an offline account still shows when it was last seen.
export const BEAT_MS = 5_000;
const ONLINE_MS = 3 * BEAT_MS;
const GAME = new Set(["loading", "running"]), GIFT = new Set(["queued", "sent", "opened"]);

export function createPresence(db) {
  const sql = {
    put: db.prepare(`INSERT INTO last_seen (user_id, at, state) VALUES (?, game.utc_text(), ?)
      ON CONFLICT (user_id) DO UPDATE SET at = excluded.at, state = excluded.state`),
    all: db.prepare("SELECT user_id AS id, at FROM last_seen"),
  };
  const live = new Map();   // user id -> { at (ms), state }

  // Only the known fields: the page's report is not trusted for anything else.
  function clean({ game, visible, gift } = {}) {
    return { game: GAME.has(game) ? game : "page", visible: visible !== false, gift: GIFT.has(gift) ? gift : null };
  }

  return {
    async beat(userId, report) {
      const state = clean(report);
      live.set(userId, { at: Date.now(), state });
      await sql.put.run(userId, JSON.stringify(state));
    },
    leave: (userId) => live.delete(userId),
    // user id -> { online, seen (UTC, "YYYY-MM-DD HH:MM:SS"), state while online }
    async all() {
      const out = new Map();
      for (const { id, at } of await sql.all.all()) out.set(id, { online: false, seen: at, state: null });
      const now = Date.now();
      for (const [id, { at, state }] of live) {
        if (now - at > ONLINE_MS) { live.delete(id); continue; }
        out.set(id, { ...out.get(id), online: true, state });
      }
      return out;
    },
  };
}
