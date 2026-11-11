// The site's database: Postgres on Supabase (schema "game", web/db/schema.sql), reached as the
// game_server role through DATABASE_URL. The modules keep the small statement API they had with
// SQLite, now async: db.prepare(sql) with "?" placeholders, then await .get(), .all() or .run().
import postgres from "postgres";

// "?" -> "$1", "$2"... (outside quoted text).
function placeholders(text) {
  let out = "", n = 0, quoted = false;
  for (const c of text) {
    if (c === "'") quoted = !quoted;
    out += c === "?" && !quoted ? `$${++n}` : c;
  }
  return out;
}

export function openDb(url) {
  if (!url) {
    throw new Error("DATABASE_URL is not set: the server needs the Supabase database (docs/supabase_database.md).");
  }
  const pg = postgres(url, {
    max: Number(process.env.DB_POOL ?? 5),
    prepare: true,
    onnotice: () => {},
    // Ids, counts and millisecond times are int8: plain numbers here, as they were with SQLite.
    types: { bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) } },
  });
  const run = (text, params) => pg.unsafe(text, params.map((p) => (p === undefined ? null : p)), { prepare: true });
  return {
    prepare(sql) {
      const text = placeholders(sql);
      return {
        get: async (...params) => (await run(text, params))[0],
        all: async (...params) => Array.from(await run(text, params)),
        // changes: rows written; id: the first returned row's id (statements ending in RETURNING id).
        run: async (...params) => { const rows = await run(text, params); return { changes: rows.count, id: rows[0]?.id }; },
      };
    },
    end: () => pg.end({ timeout: 5 }),
  };
}

// For work that runs without anyone awaiting it (timers, closed connections): log, never crash.
export const background = (promise, what = "db") => { promise?.catch?.((err) => console.error(`${what}:`, err)); };
