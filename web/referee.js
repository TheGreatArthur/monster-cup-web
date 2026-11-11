// Anti-cheat, step 3 (docs/anti_cheat_strategy.md, R5): the referee replays a match in a headless
// emulator, once from each side, and gives the official result.
// - A replay loads the player's save as it was at the start of the battle, picks the same team,
//   gets the opponent's packets from the match journal and the match's seed. Its game sends its own
//   packets: when they differ from what the player's page relayed, that page sent a doctored team.
// - Both replays compute the same battle as the real games did; their outcome is the result.
// The replay runs in Edge driven by web/referee/worker.py (Python + Playwright), one at a time.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSave, readDigimon } from "./save-check.js";
import { background } from "./db.js";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "referee", "worker.py");
const PYTHON = process.env.REFEREE_PYTHON ?? "python";
const WORKER_TIMEOUT_MS = 15 * 60_000;
const SIDES = ["host", "guest"];

// verdict(matchId, { winnerSide, tampered: [sides], results }) applies the official result.
// saves.rememberRecord(hash, data) keeps the records the replayed game sent (server.js).
// referee_jobs (web/db/schema.sql): reason disputed, unverified, sample or admin; status pending,
// running, done or failed; results JSON { host: {won, mismatches}, guest: ... }.
export function createReferee({ db, readJson, sendJson, port, romVersion, saves, verdict }) {
  const sql = {
    insert: db.prepare("INSERT INTO referee_jobs (match_id, reason) VALUES (?, ?)"),
    next: db.prepare("SELECT id, match_id FROM referee_jobs WHERE status = 'pending' ORDER BY id LIMIT 1"),
    status: db.prepare(`UPDATE referee_jobs SET status = ?, results = ?,
      finished_at = CASE WHEN ?::int = 1 THEN game.utc_text() END WHERE id = ?`),
    restart: db.prepare("UPDATE referee_jobs SET status = 'pending' WHERE status = 'running'"),
    match: db.prepare("SELECT id, host_id, guest_id, seed FROM online_matches WHERE id = ?"),
    save: db.prepare("SELECT data, slots FROM online_match_saves WHERE match_id = ? AND side = ?"),
    packets: db.prepare(`SELECT detail FROM online_match_events WHERE match_id = ? AND kind = 'packet'
      AND detail <> 'out of turn' ORDER BY id`),
  };

  const token = randomBytes(32).toString("base64url");
  let current = null;   // { id, match, side, results, child }; { starting: true } while a job is fetched

  function authorized(req) {
    const value = /(?:^|;\s*)referee=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return value !== undefined && value.length === token.length
      && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  }

  async function enqueue(matchId, reason) {
    await sql.insert.run(matchId, reason);
    await runNext();
  }

  async function runNext() {
    if (current || process.env.REFEREE === "off") return;
    current = { starting: true };
    try {
      const job = await sql.next.get();
      if (!job) return void (current = null);
      await sql.status.run("running", null, 0, job.id);
      current = { id: job.id, match: job.match_id, side: null, results: {} };
    } catch (err) {
      current = null;
      throw err;
    }
    replay(SIDES[0]);
  }

  function replay(side) {
    current.side = side;
    const child = spawn(PYTHON, [WORKER, `http://127.0.0.1:${port}`, String(current.match), side], {
      env: { ...process.env, REFEREE_TOKEN: token }, stdio: ["ignore", "inherit", "inherit"],
    });
    const job = current;
    const timer = setTimeout(() => child.kill(), WORKER_TIMEOUT_MS);
    child.on("error", (err) => console.error(`referee worker: ${err.message}`));
    child.on("close", () => {
      clearTimeout(timer);
      if (current !== job) return;
      if (!job.results[side]) return background(end("failed"), "referee");   // the replay did not reach a result
      const nextSide = SIDES[SIDES.indexOf(side) + 1];
      if (nextSide) return replay(nextSide);
      background(end("done"), "referee");
    });
  }

  async function end(status) {
    const job = current;
    current = null;
    try {
      await sql.status.run(status, JSON.stringify(job.results), 1, job.id);
      if (status === "done") await verdict(job.match, decide(job.results));
    } finally {
      await runNext();
    }
  }

  // A side whose replay sent other packets than its page did doctored its team: it loses. Otherwise
  // the replays say who won (one replay's win is the other's defeat).
  function decide(results) {
    const tampered = SIDES.filter((s) => results[s].mismatches.length > 0);
    let winnerSide = null;
    if (tampered.length === 1) winnerSide = SIDES.find((s) => s !== tampered[0]);
    else if (!tampered.length && results.host.won !== results.guest.won) winnerSide = results.host.won ? "host" : "guest";
    return { winnerSide, tampered, results };
  }

  // The team records the replayed game sent (members[k]: base64, for team position k) are what
  // the game builds from those save slots: online.js then checks relayed records against them.
  async function remember(matchId, side, members) {
    const save = await sql.save.get(matchId, side);
    const slots = JSON.parse(save.slots);
    const digimon = readDigimon(decodeSave(save.data));
    for (const [k, data] of members.entries()) {
      const d = slots[k] !== null && digimon.find((x) => x.slot === slots[k]);
      if (d && typeof data === "string") await saves.rememberRecord(d.record, Buffer.from(data, "base64"));
    }
  }

  // Routes for the worker's page (cookie "referee"). Returns true when handled.
  async function handle(route, req, res, url, serveStatic) {
    if (!authorized(req)) return false;
    if (route === "GET /referee") return serveStatic(res, "referee.html"), true;
    if (route === "GET /api/referee/job") {
      const matchId = Number(url.searchParams.get("match")), side = url.searchParams.get("side");
      if (!Number.isInteger(matchId) || !SIDES.includes(side)) return sendJson(res, 404, { error: "no such replay" }), true;
      const [match, save] = await Promise.all([sql.match.get(matchId), sql.save.get(matchId, side)]);
      if (!match || !save) return sendJson(res, 404, { error: "no such replay" }), true;
      sendJson(res, 200, {
        match: matchId, side, role: side === "host" ? 1 : 2, seed: match.seed, romVersion: romVersion(),
        save: Buffer.from(save.data).toString("base64"), slots: JSON.parse(save.slots),
        packets: (await sql.packets.all(matchId)).map((p) => p.detail),
      });
      return true;
    }
    if (route === "POST /api/referee/verdict") {
      const { match, side, won, mismatches, members } = await readJson(req);
      if (!current || current.match !== match || current.side !== side || typeof won !== "boolean"
        || !Array.isArray(mismatches) || !Array.isArray(members)) {
        return sendJson(res, 409, { error: "unexpected verdict" }), true;
      }
      current.results[side] = { won, mismatches };
      await remember(match, side, members);
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  // Jobs interrupted by a restart start over, once the server listens.
  setTimeout(() => background(sql.restart.run().then(runNext), "referee"), 1000);
  return { enqueue, handle, authorized };
}
