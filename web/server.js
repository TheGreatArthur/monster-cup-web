// Web server: accounts, sessions and cloud saves for the browser emulator. It serves no ROM to
// players: each one brings their own copy, modded in the browser (public/rom.js).
// Node >= 24. The data lives in the Supabase Postgres database (db.js, DATABASE_URL in web/.env).
// Listens on 127.0.0.1 unless HOST says otherwise (0.0.0.0 on a host, see render.yaml).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { encodeSave, setTamerName, setEggHatch, BABY_SPECIES } from "./save-codec.js";
import { createOnline } from "./online.js";
import { createReferee } from "./referee.js";
import { createSanctions } from "./sanctions.js";
import { createAdmin } from "./admin.js";
import { decodeSave, readDigimon, checkSave } from "./save-check.js";
import { readProfile } from "./save-info.js";
import { loadGameData } from "./game-data.js";
import { createGifts } from "./gifts.js";
import { createShop } from "./shop.js";
import { createBank } from "./bank.js";
import { createEvents } from "./events.js";
import { createPresence } from "./presence.js";
import { createDiscordAuth, DISCORD_ENABLED, PASSWORD_ENABLED, REGISTER_ENABLED } from "./discord-auth.js";
import { createSocial } from "./social.js";
import { openDb } from "./db.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);
// Behind a host's proxy (TRUST_PROXY=1) the player's address is in X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
// Cookies only travel over HTTPS once the site has an https address.
const COOKIE = `HttpOnly; SameSite=Strict; Path=/${(process.env.SITE_URL ?? "").startsWith("https:") ? "; Secure" : ""}`;
const ROM_PATH = path.resolve(root, process.env.ROM_PATH ?? "../build/digimon_mod.nds");
const PUBLIC_DIR = path.join(root, "public");
// Game graphics exported by tools/export_wheel_assets.py: served to logged-in users only.
const GAME_ASSETS_DIR = path.join(root, "game-assets");
const INTRO_ASSETS_DIR = path.join(GAME_ASSETS_DIR, "intro");
// Decoded save taken at "Please name your DigiEgg" (tamer registered, Agumon in a cage): a new
// account starts from it once it picked the baby the egg hatches into on the starter wheel.
const STARTER_RAW = fs.readFileSync(path.join(root, "starter", "starter.raw"));
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_SAVE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const MIN_PASSWORD = 8;

const scryptAsync = promisify(scrypt);

// The tables are in web/db/schema.sql (applied to the Supabase project once).
const db = openDb(process.env.DATABASE_URL);

const sql = {
  insertUser: db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id"),
  userByName: db.prepare("SELECT id, username, password_hash FROM users WHERE lower(username) = lower(?)"),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  sessionUser: db.prepare(`SELECT u.id, u.username, u.discord_id, u.display_name, u.avatar_url
                           FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ? AND s.expires_at > ?`),
  storySeen: db.prepare("SELECT story_seen_at FROM users WHERE id = ?"),
  markStorySeen: db.prepare("UPDATE users SET story_seen_at = game.utc_text() WHERE id = ? AND story_seen_at IS NULL"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  getSave: db.prepare("SELECT data, sha256, updated_at FROM saves WHERE user_id = ?"),
  saveMeta: db.prepare("SELECT sha256, updated_at FROM saves WHERE user_id = ?"),
  putSave: db.prepare(`INSERT INTO saves (user_id, data, size, sha256, updated_at)
                       VALUES (?, ?, ?, ?, game.utc_text())
                       ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, size = excluded.size,
                         sha256 = excluded.sha256, updated_at = excluded.updated_at
                       RETURNING updated_at`),
  lastHistory: db.prepare("SELECT at, digimon FROM save_history WHERE user_id = ? ORDER BY id DESC LIMIT 1"),
  insertHistory: db.prepare("INSERT INTO save_history (user_id, at, sha256, digimon, problems) VALUES (?, ?, ?, ?, ?)"),
  flag: db.prepare("INSERT INTO save_flags (user_id, problems) VALUES (?, ?) ON CONFLICT DO NOTHING"),
  flagged: db.prepare("SELECT 1 FROM save_flags WHERE user_id = ?"),
  knownRecord: db.prepare("SELECT data FROM known_records WHERE record = ?"),
  rememberRecord: db.prepare(`INSERT INTO known_records (record, data) VALUES (?, ?)
                              ON CONFLICT (record) DO UPDATE SET data = excluded.data, at = game.utc_text()`),
  withoutHistory: db.prepare(`SELECT user_id, data, sha256 FROM saves
                              WHERE user_id NOT IN (SELECT user_id FROM save_history)`),
};

// --- save checks (anti-cheat step 2, save-check.js) ------------------------------

// The game's tables, from the ROM where it is and from game-data.json on a host (game-data.js).
const { rom: gameRom, tables: gameTables, info: gameInfo } = loadGameData(ROM_PATH, path.join(root, "..", "text"));
// The mod the players' browsers build (tools/make_web_patch.py): SHA-256 of the modded ROM.
const patchRom = fs.readFileSync(path.join(PUBLIC_DIR, "mod.patch")).subarray(48, 80).toString("hex");

// Filled in once the modules below exist: enqueue (referee.js), review and rankedRefusal (sanctions.js),
// gifts (gifts.js).
const onlineHooks = {};

// Checks a save against the account's previous one and keeps its Digimon. Returns the problems.
async function recordSave(userId, data, hash) {
  const now = Date.now();
  const last = await sql.lastHistory.get(userId);
  const prev = last?.digimon ? JSON.parse(last.digimon) : null;
  let digimon = null, problems;
  try {
    digimon = readDigimon(decodeSave(data));
    const used = new Set();
    // Stats the game could not give on its own but the site did: an admin's bonus, a banked
    // Digimon on its way back (bank.js).
    const bonuses = gameTables && onlineHooks.gifts ? [...await onlineHooks.gifts.unseenBonuses(userId),
      ...await onlineHooks.bank?.exemptions(userId) ?? []] : undefined;
    problems = gameTables ? checkSave(digimon, prev, now - (last?.at ?? now), gameTables, bonuses, used) : [];
    for (const id of used) if (typeof id === "number") await onlineHooks.gifts.bonusSeen(id);
  } catch (err) {
    problems = [`sauvegarde illisible : ${err.message}`];
  }
  await sql.insertHistory.run(userId, now, hash, digimon && JSON.stringify(digimon),
    problems.length ? JSON.stringify(problems) : null);
  await onlineHooks.bank?.onSave(userId, digimon);   // deposits and withdrawals this save confirms
  if (problems.length) {
    await sql.flag.run(userId, JSON.stringify(problems));
    await onlineHooks.review?.(userId);   // a flag counts towards the trust score
  }
  return problems;
}

// What the online module needs: is the account barred from ranked, and its saved Digimon.
const digimonCache = new Map();   // user id -> { sha256, digimon }
const saves = {
  flagged: async (userId) => (await sql.flagged.get(userId)) !== undefined,
  data: async (userId) => (await sql.getSave.get(userId))?.data ?? new Uint8Array(),
  knownRecord: async (hash) => { const row = await sql.knownRecord.get(hash); return row && Buffer.from(row.data); },
  rememberRecord: (hash, data) => sql.rememberRecord.run(hash, data),
  async digimon(userId) {
    const save = await sql.getSave.get(userId);
    if (!save) return null;
    const cached = digimonCache.get(userId);
    if (cached?.sha256 === save.sha256) return cached.digimon;
    let digimon = null;
    try { digimon = readDigimon(decodeSave(save.data)); } catch { /* unreadable: null */ }
    digimonCache.set(userId, { sha256: save.sha256, digimon });
    return digimon;
  },
};

// --- passwords and sessions -------------------------------------------------

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

// Compares in constant time; a missing user still costs one scrypt so timing does not reveal it.
const DUMMY_HASH = await hashPassword("dummy-password-for-timing");
// Discord accounts (discord-auth.js) store "!": no password can match it.
async function verifyPassword(password, stored) {
  const usable = stored?.includes(":");
  const [saltHex, keyHex] = (usable ? stored : DUMMY_HASH).split(":");
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
  return usable && timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function createSession(res, userId) {
  const token = randomBytes(32).toString("base64url");
  await sql.insertSession.run(sha256(token), userId, Date.now() + SESSION_MS);
  res.appendHeader("Set-Cookie",
    `sid=${token}; ${COOKIE}; Max-Age=${SESSION_MS / 1000}`);
}

function sessionToken(req) {
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "");
  return match?.[1];
}

// A random id per browser, kept for years: ranked search never pairs two accounts of one browser.
function deviceId(req, res) {
  const id = /(?:^|;\s*)device=([\w-]{16,64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
  if (id) return id;
  const fresh = randomBytes(16).toString("base64url");
  res.appendHeader("Set-Cookie", `device=${fresh}; ${COOKIE}; Max-Age=${5 * 365 * 24 * 3600}`);
  return fresh;
}

async function currentUser(req) {
  const token = sessionToken(req);
  return token ? sql.sessionUser.get(sha256(token), Date.now()) : undefined;
}
const sessionOwner = async (req) => (await currentUser(req))?.id;

// --- HTTP helpers -------------------------------------------------------------

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json");
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// JSON-only POSTs: a cross-site HTML form cannot send application/json (with SameSite=Strict on top).
async function readJson(req) {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw Object.assign(new Error("expected application/json"), { status: 415 });
  }
  try {
    return JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

// romVersion changes with every rebuild of the mod, so the referee's ROM URL (and the emulator's
// cache entry) changes too and a rebuilt mod is never replayed from a stale cache.
const romVersion = () => patchRom.slice(0, 12);

const handleOnline = createOnline(db, readJson, sendJson, saves, onlineHooks);
const referee = createReferee({ db, readJson, sendJson, port: PORT, romVersion, saves,
  verdict: (matchId, verdict) => handleOnline.applyVerdict(matchId, verdict) });
const sanctions = createSanctions(db);
Object.assign(onlineHooks, { enqueue: referee.enqueue, review: sanctions.review, rankedRefusal: sanctions.rankedRefusal });
// Admin pages for the players' saves, who is playing and gifts (save-info.js, presence.js, gifts.js).
const gifts = createGifts(db, gameInfo.mails);
onlineHooks.gifts = gifts;
// PvP coins paid by online wins, spent in the play page's shop (shop.js); the Digimon bank and its
// trades (bank.js); events with coin rewards (events.js).
const shop = createShop({ db, readJson, sendJson, gameInfo, gifts });
onlineHooks.coins = shop;
const bank = createBank({ db, readJson, sendJson, gameInfo, gameTables, gifts, flagged: saves.flagged });
onlineHooks.bank = bank;
const events = createEvents({ db, readJson, sendJson, gameInfo, shop, bank });
const presence = createPresence(db);
const profileCache = new Map();   // user id -> { sha256, profile }
async function playerProfile(userId) {
  const save = await sql.getSave.get(userId);
  if (!save) return null;
  const cached = profileCache.get(userId);
  if (cached?.sha256 !== save.sha256) {
    let profile;
    try { profile = readProfile(decodeSave(save.data), gameInfo, gameTables); } catch (err) { profile = { error: err.message }; }
    profileCache.set(userId, { sha256: save.sha256, profile });
  }
  return { updated: save.updated_at, ...profileCache.get(userId).profile };
}
// Discord login through Supabase (discord-auth.js), friends and chat (social.js).
const handleDiscord = createDiscordAuth({ db, readJson, sendJson, redirect, createSession, sessionOwner });
const handleSocial = createSocial({ db, readJson, sendJson });
const handleAdmin = createAdmin({ db, readJson, sendJson, serveStatic, sanctions, online: handleOnline, referee,
  gifts, presence, gameInfo, playerProfile, shop, events });

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".json": "application/json",
};
function serveStatic(res, file, dir = PUBLIC_DIR) {
  const full = path.join(dir, file);
  if (!full.startsWith(dir + path.sep) || !fs.existsSync(full)) return send(res, 404, "Not found");
  send(res, 200, fs.readFileSync(full), STATIC_TYPES[path.extname(full)] ?? "application/octet-stream");
}

// --- routes ---------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  const user = await currentUser(req);
  req.device = deviceId(req, res);
  req.clientIp = (TRUST_PROXY && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress;

  // A new account has no save until it picks its starter on the wheel (/starter).
  const hasSave = async () => user !== undefined && (await sql.saveMeta.get(user.id)) !== undefined;
  if (route === "GET /") return user ? redirect(res, "/play") : serveStatic(res, "index.html");
  if (route === "GET /play") {
    if (!user) return redirect(res, "/");
    if (!await hasSave()) return redirect(res, "/starter");
    // Cross-origin isolation gives the page SharedArrayBuffer, which the emulator's threaded core
    // needs (play.js). The emulator's CDN sends Cross-Origin-Resource-Policy: cross-origin.
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    return serveStatic(res, "play.html");
  }
  // Before the wheel, a new account watches the story intro once (/story).
  if (route === "GET /starter") {
    if (!user) return redirect(res, "/");
    if (await hasSave()) return redirect(res, "/play");
    return (await sql.storySeen.get(user.id)).story_seen_at ? serveStatic(res, "starter.html") : redirect(res, "/story");
  }
  if (route === "GET /story") {
    if (!user) return redirect(res, "/");
    return await hasSave() ? redirect(res, "/play") : serveStatic(res, "story.html");
  }
  if (req.method === "GET" && url.pathname.startsWith("/static/")) {
    return serveStatic(res, url.pathname.slice("/static/".length));
  }
  // The intro page's game graphics (tools/export_site_assets.py) show before login; the rest of
  // game-assets/ stays behind it.
  if (req.method === "GET" && url.pathname.startsWith("/game-assets/intro/")) {
    return serveStatic(res, url.pathname.slice("/game-assets/intro/".length), INTRO_ASSETS_DIR);
  }

  if (route === "GET /auth/callback") return serveStatic(res, "auth-callback.html");
  if (await handleDiscord(route, req, res, user, url)) return;

  if ((route === "POST /api/register" && !REGISTER_ENABLED) || (route === "POST /api/login" && !PASSWORD_ENABLED)) {
    return sendJson(res, 403, { error: "Log in with Discord." });
  }
  if (route === "POST /api/register") {
    const { username, password } = await readJson(req);
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return sendJson(res, 400, { error: "Username: 3 to 20 characters (letters, digits, _ or -)." });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      return sendJson(res, 400, { error: `Password: at least ${MIN_PASSWORD} characters.` });
    }
    const taken = { status: 409, message: "This username is already taken." };
    if (await sql.userByName.get(username)) throw taken;
    const { id } = await sql.insertUser.run(username, await hashPassword(password))
      .catch((err) => { throw err.code === "23505" ? taken : err; });   // registered at the same moment
    await createSession(res, id);
    return sendJson(res, 201, { id, username });
  }

  if (route === "POST /api/login") {
    const { username, password } = await readJson(req);
    const row = typeof username === "string" ? await sql.userByName.get(username) : undefined;
    const ok = await verifyPassword(typeof password === "string" ? password : "", row?.password_hash);
    if (!ok) return sendJson(res, 401, { error: "Wrong username or password." });
    await createSession(res, row.id);
    return sendJson(res, 200, { id: row.id, username: row.username });
  }

  if (route === "POST /api/logout") {
    await readJson(req);
    const token = sessionToken(req);
    if (token) await sql.deleteSession.run(sha256(token));
    if (user) presence.leave(user.id);
    res.appendHeader("Set-Cookie", `sid=; ${COOKIE}; Max-Age=0`);
    return sendJson(res, 200, { ok: true });
  }

  // The referee's page (referee.js, its own cookie) and the ROM it replays on. That ROM goes to
  // the referee only, a browser on this machine: players bring their own (public/rom.js).
  // EmulatorJS sends a HEAD first to learn the size for its cache, then the GET.
  if (await referee.handle(route, req, res, url, serveStatic)) return;
  if ((req.method === "GET" || req.method === "HEAD") && /^\/rom\/[\w-]+\.nds$/.test(url.pathname) && referee.authorized(req)) {
    if (!fs.existsSync(ROM_PATH)) return send(res, 500, `ROM introuvable : ${ROM_PATH}`);
    const stat = fs.statSync(ROM_PATH);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Last-Modified": stat.mtime.toUTCString(),
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(ROM_PATH).pipe(res);
  }

  // Everything below requires a session.
  if (!user) return sendJson(res, 401, { error: "Non connecté." });

  if (route === "GET /api/me") {
    const save = await sql.saveMeta.get(user.id);
    return sendJson(res, 200, {
      id: user.id, username: user.username, name: user.display_name ?? user.username,
      avatar: user.avatar_url ? `/avatar/${user.id}` : null, discord: Boolean(user.discord_id), discordLogin: DISCORD_ENABLED,
      saveUpdatedAt: save?.updated_at ?? null,
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/game-assets/")) {
    return serveStatic(res, url.pathname.slice("/game-assets/".length), GAME_ASSETS_DIR);
  }

  // The story intro ended (or was skipped): the account goes on to the starter wheel.
  if (route === "POST /api/story/seen") {
    await readJson(req);
    await sql.markStorySeen.run(user.id);
    return sendJson(res, 200, { ok: true });
  }

  // The starter wheel's pick: the species the DigiEgg hatches into. Only once, before any save.
  if (route === "POST /api/starter") {
    const { species } = await readJson(req);
    if (!Number.isInteger(species) || species < BABY_SPECIES.min || species > BABY_SPECIES.max) {
      return sendJson(res, 400, { error: "Unknown Baby Digimon." });
    }
    if (await hasSave()) return sendJson(res, 409, { error: "Your partner is already chosen." });
    const data = Buffer.from(encodeSave(setEggHatch(setTamerName(STARTER_RAW, user.username), species)));
    await sql.putSave.run(user.id, data, data.length, sha256(data));
    await recordSave(user.id, data, sha256(data));   // the start of the account's history
    return sendJson(res, 201, { species });
  }

  if (route === "GET /api/save") {
    const save = await sql.getSave.get(user.id);
    if (!save) return sendJson(res, 409, { error: "Choisis d'abord ton starter." });
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Save-Sha256": save.sha256,
      "X-Save-Updated-At": save.updated_at,
    });
    return res.end(Buffer.from(save.data));
  }

  if (route === "PUT /api/save") {
    if (req.headers["content-type"] !== "application/octet-stream") {
      return sendJson(res, 415, { error: "expected application/octet-stream" });
    }
    const data = await readBody(req, MAX_SAVE_BYTES);
    if (data.length === 0) return sendJson(res, 400, { error: "Sauvegarde vide." });
    const hash = sha256(data);
    const { updated_at: updatedAt } = await sql.putSave.get(user.id, data, data.length, hash);
    // A save that breaks the rules is still kept (solo play goes on) but bars ranked play.
    await recordSave(user.id, data, hash);
    return sendJson(res, 200, { size: data.length, sha256: hash, updatedAt, flagged: await saves.flagged(user.id) });
  }

  if (url.pathname.startsWith("/api/online/") && await handleOnline(route, req, res, user)) return;
  if (await handleSocial(route, req, res, user, url)) return;
  if (url.pathname.startsWith("/api/shop") && await shop.handle(route, req, res, user)) return;
  if (url.pathname.startsWith("/api/bank") && await bank.handle(route, req, res, user, url)) return;
  if (url.pathname.startsWith("/api/events") && await events.handle(route, req, res, user)) return;
  if (await handleAdmin(route, req, res, user, url)) return;

  // Gifts from the admins, delivered by the play page through the game's mail (gifts.js).
  // The play page's reports for the admins' live page (presence.js); the answer tells it a gift waits.
  if (route === "POST /api/presence") {
    await presence.beat(user.id, await readJson(req));
    return sendJson(res, 200, { pending: (await gifts.pending(user.id)).length });
  }
  if (route === "POST /api/presence/leave") return await readJson(req), presence.leave(user.id), sendJson(res, 200, { ok: true });
  if (route === "GET /api/gifts/pending") return sendJson(res, 200, { gifts: await gifts.pending(user.id) });
  const delivered = req.method === "POST" && url.pathname.match(/^\/api\/gifts\/(\d+)\/delivered$/);
  if (delivered) return sendJson(res, 200, { ok: await gifts.delivered(user.id, Number(delivered[1])) });

  return sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.status ? err.message : "Erreur serveur." });
    if (!err.status) console.error(err);
  });
});

await sql.purgeSessions.run(Date.now());
// Accounts from before the checks: their current save starts their history, so the next upload
// is checked against it.
for (const { user_id: userId, data, sha256: hash } of await sql.withoutHistory.all()) {
  await recordSave(userId, data, hash);
}
server.listen(PORT, HOST, () => {
  console.log(`Digimon web: http://${HOST}:${PORT}`);
  console.log(`Mod: ${patchRom.slice(0, 12)}${gameRom === patchRom ? "" : "  (game tables are from another build: run tools/make_web_patch.py and node web/game-data.js)"}`);
  console.log(`DB:  Supabase (${new URL(process.env.DATABASE_URL).hostname})`);
});
