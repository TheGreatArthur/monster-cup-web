// One-time move of the old local database (web/data/app.db, SQLite) into the Supabase database:
// every table, same ids, in one transaction. Refuses to run when Supabase already has accounts.
//   node --env-file=web/.env web/db/import-sqlite.js [path to app.db]
// Afterwards the id counters must start past the copied ids (docs/supabase_database.md).
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2] ?? path.join(here, "..", "data", "app.db"));
// Parents before children (foreign keys).
const TABLES = ["users", "sessions", "saves", "save_history", "known_records", "save_flags", "online_matches",
  "ratings", "online_match_events", "online_incidents", "online_match_saves", "referee_jobs", "ranked_bans",
  "gifts", "last_seen", "friend_requests", "friends", "chat_messages"];

const local = new DatabaseSync(source, { readOnly: true });
const pg = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const exists = new Set(local.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));

try {
  const [{ n }] = await pg`SELECT count(*)::int AS n FROM users`;
  if (n > 0) throw new Error(`Supabase already has ${n} accounts: nothing copied.`);
  await pg.begin(async (tx) => {
    for (const table of TABLES) {
      if (!exists.has(table)) { console.log(`${table}: not in ${path.basename(source)}`); continue; }
      const rows = local.prepare(`SELECT * FROM "${table}"`).all()
        .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v) : v])));
      for (let i = 0; i < rows.length; i += 500) await tx`INSERT INTO ${tx(table)} ${tx(rows.slice(i, i + 500))}`;
      console.log(`${table}: ${rows.length}`);
    }
  });
  console.log("Done.");
} finally {
  await pg.end();
}
