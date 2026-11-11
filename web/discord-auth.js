// Discord login through Supabase Auth (docs/discord_login.md). Supabase runs the Discord OAuth
// flow and hands the page an access token; the server checks it with Supabase, then keeps its own
// accounts, saves and session cookie as before. One Discord account = one account = one save.
//
// Flow: GET /auth/discord sets a one-time "oauth" cookie and redirects to Supabase, which sends the
// browser back to /auth/callback with the token in the URL fragment. That page posts the token to
// POST /api/auth/discord, which needs the cookie: a token from a link someone else crafted is
// refused. With ?link=1 a logged-in account (an old password account) gets the Discord account
// linked to it instead of a new account.
import { randomBytes } from "node:crypto";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ?? "";   // the public "anon" / publishable key
export const DISCORD_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);
// Username + password accounts: always on without Discord. With Discord, new accounts come from
// Discord only, and the password login of existing accounts depends on PASSWORD_LOGIN: "1" shows
// it on the login page, "hidden" keeps it working but shows it only at /?password (tests).
const PASSWORD_MODE = process.env.PASSWORD_LOGIN ?? "";
export const PASSWORD_ENABLED = !DISCORD_ENABLED || PASSWORD_MODE === "1" || PASSWORD_MODE === "hidden";
const PASSWORD_SHOWN = !DISCORD_ENABLED || PASSWORD_MODE === "1";
export const REGISTER_ENABLED = !DISCORD_ENABLED;
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
const FLOW_MS = 10 * 60_000;
const AVATAR_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const AVATAR_MS = 6 * 3600_000;

// "arthur#0" -> "arthur": a free username (3 to 20 of [A-Za-z0-9_-]) close to the Discord one.
function baseUsername(meta) {
  const raw = String(meta.name ?? meta.user_name ?? meta.full_name ?? "").replace(/#\d+$/, "");
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return clean.length >= 3 ? clean : `tamer${clean}`;
}

function profileOf(user) {
  const meta = user.user_metadata ?? {};
  const discordId = String(meta.provider_id ?? meta.sub ?? "");
  const display = String(meta.custom_claims?.global_name ?? meta.full_name ?? meta.name ?? "")
    .replace(/#\d+$/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  let avatar = String(meta.avatar_url ?? meta.picture ?? "");
  try { if (!AVATAR_HOSTS.has(new URL(avatar).hostname)) avatar = ""; } catch { avatar = ""; }
  return { supabaseId: String(user.id), discordId, display: display || null, avatar: avatar || null, base: baseUsername(meta) };
}

export function createDiscordAuth({ db, readJson, sendJson, redirect, createSession, sessionOwner }) {
  const sql = {
    bySupabase: db.prepare("SELECT id FROM users WHERE supabase_id = ?"),
    byName: db.prepare("SELECT 1 FROM users WHERE lower(username) = lower(?)"),
    linked: db.prepare("SELECT supabase_id FROM users WHERE id = ?"),
    insert: db.prepare(`INSERT INTO users (username, password_hash, supabase_id, discord_id, display_name, avatar_url)
      VALUES (?, '!', ?, ?, ?, ?) RETURNING id`),
    update: db.prepare("UPDATE users SET supabase_id = ?, discord_id = ?, display_name = ?, avatar_url = ? WHERE id = ?"),
    avatarUrl: db.prepare("SELECT avatar_url FROM users WHERE id = ?"),
  };
  const flows = new Map();     // oauth cookie -> { at, linkTo: user id | null }
  const avatars = new Map();   // user id -> { url, at, type, body }

  const cookie = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(req.headers.cookie ?? "")?.[1];

  async function freeUsername(base) {
    if (!await sql.byName.get(base)) return base;
    for (let n = 2; ; n++) {
      const name = `${base.slice(0, 20 - String(n).length)}${n}`;
      if (!await sql.byName.get(name)) return name;
    }
  }

  // The Supabase user behind an access token, or null when Supabase refuses it.
  async function supabaseUser(token) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    const discord = user.app_metadata?.provider === "discord"
      || (user.identities ?? []).some((i) => i.provider === "discord");
    return discord ? user : null;
  }

  async function avatar(res, userId) {
    const url = (await sql.avatarUrl.get(userId))?.avatar_url;
    if (!url) return sendJson(res, 404, { error: "No avatar." });
    let entry = avatars.get(userId);
    if (!entry || entry.url !== url || Date.now() - entry.at > AVATAR_MS) {
      const sized = new URL(url);
      if (sized.hostname === "cdn.discordapp.com") sized.searchParams.set("size", "128");
      const got = await fetch(sized).catch(() => null);
      if (!got?.ok || !(got.headers.get("content-type") ?? "").startsWith("image/")) return sendJson(res, 404, { error: "No avatar." });
      entry = { url, at: Date.now(), type: got.headers.get("content-type"), body: Buffer.from(await got.arrayBuffer()) };
      avatars.set(userId, entry);
    }
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "private, max-age=3600" });
    return res.end(entry.body);
  }

  // Returns true when the route was one of these.
  return async function handleDiscord(route, req, res, user, url) {
    if (route === "GET /api/auth/config") {
      return sendJson(res, 200, { discord: DISCORD_ENABLED, password: PASSWORD_SHOWN, register: REGISTER_ENABLED }), true;
    }

    if (route === "GET /auth/discord") {
      if (!DISCORD_ENABLED) return sendJson(res, 503, { error: "Discord login is not set up on this server." }), true;
      for (const [key, flow] of flows) if (Date.now() - flow.at > FLOW_MS) flows.delete(key);
      const key = randomBytes(24).toString("base64url");
      flows.set(key, { at: Date.now(), linkTo: url.searchParams.get("link") === "1" && user ? user.id : null });
      // Lax: the cookie must survive the top-level redirect chain back from Discord and Supabase.
      res.appendHeader("Set-Cookie", `oauth=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${FLOW_MS / 1000}`);
      const site = SITE_URL || `http://${req.headers.host}`;
      const target = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
      target.searchParams.set("provider", "discord");
      target.searchParams.set("redirect_to", `${site}/auth/callback`);
      target.searchParams.set("scopes", "identify");
      return redirect(res, target.href), true;
    }

    if (route === "POST /api/auth/discord") {
      const { accessToken } = await readJson(req);
      const key = cookie(req, "oauth");
      const flow = key && flows.get(key);
      res.appendHeader("Set-Cookie", "oauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
      if (key) flows.delete(key);
      if (!flow || Date.now() - flow.at > FLOW_MS) {
        return sendJson(res, 400, { error: "This login link expired. Please try again." }), true;
      }
      if (typeof accessToken !== "string" || accessToken.length > 8192) return sendJson(res, 400, { error: "Missing token." }), true;
      const sbUser = await supabaseUser(accessToken).catch(() => null);
      if (!sbUser) return sendJson(res, 401, { error: "Discord login failed. Please try again." }), true;
      // Our own session replaces Supabase's: sign it out (fire and forget).
      fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` } }).catch(() => {});

      const p = profileOf(sbUser);
      let id = (await sql.bySupabase.get(p.supabaseId))?.id;
      if (flow.linkTo) {
        if (id !== undefined && id !== flow.linkTo) {
          return sendJson(res, 409, { error: "This Discord account already has its own account on this site." }), true;
        }
        if (await sessionOwner(req) !== flow.linkTo) return sendJson(res, 401, { error: "Log in again to link Discord." }), true;
        if (id === undefined && (await sql.linked.get(flow.linkTo))?.supabase_id) {
          return sendJson(res, 409, { error: "This account is already linked to another Discord account." }), true;
        }
        id = flow.linkTo;
      }
      if (id === undefined) {
        ({ id } = await sql.insert.run(await freeUsername(p.base), p.supabaseId, p.discordId, p.display, p.avatar));
      } else {
        await sql.update.run(p.supabaseId, p.discordId, p.display, p.avatar, id);
      }
      avatars.delete(id);
      await createSession(res, id);
      return sendJson(res, 200, { ok: true, linked: Boolean(flow.linkTo) }), true;
    }

    const avatarRoute = req.method === "GET" && /^\/avatar\/(\d+)$/.exec(url.pathname);
    if (avatarRoute) {
      if (!user) return sendJson(res, 401, { error: "Not logged in." }), true;
      return await avatar(res, Number(avatarRoute[1])), true;
    }
    return false;
  };
}
