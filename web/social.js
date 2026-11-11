// Friends and chat for the play page's side panel (public/social.js): friend requests, a general
// chat everyone sees and a private chat per pair of friends. Live updates go out on a server-sent
// event stream; a player is "online" while a play page of theirs holds that stream open.
import { background } from "./db.js";

const MAX_TEXT = 300;
const HISTORY = 60;
const KEEP_GENERAL = 2000;          // the general chat keeps its last messages only
const RATE = { message: 20, request: 20 };   // per minute and per player
const NAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

// Tables (web/db/schema.sql): friend_requests, friends (both directions stored: (a, b) and (b, a)),
// chat_messages (channel 'general', or 'dm:<lower id>:<higher id>' between two friends).
export function createSocial({ db, readJson, sendJson }) {
  const PUBLIC = `u.id, COALESCE(u.display_name, u.username) AS name, u.username,
    CASE WHEN u.avatar_url IS NOT NULL THEN '/avatar/' || u.id END AS avatar`;
  const sql = {
    user: db.prepare(`SELECT ${PUBLIC} FROM users u WHERE u.id = ?`),
    byName: db.prepare(`SELECT ${PUBLIC} FROM users u WHERE lower(u.username) = lower(?)`),
    friends: db.prepare(`SELECT ${PUBLIC}, f.since FROM friends f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ? ORDER BY lower(COALESCE(u.display_name, u.username))`),
    isFriend: db.prepare("SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?"),
    incoming: db.prepare(`SELECT ${PUBLIC}, r.at FROM friend_requests r JOIN users u ON u.id = r.from_id
      WHERE r.to_id = ? ORDER BY r.at DESC`),
    outgoing: db.prepare(`SELECT ${PUBLIC}, r.at FROM friend_requests r JOIN users u ON u.id = r.to_id
      WHERE r.from_id = ? ORDER BY r.at DESC`),
    request: db.prepare("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?"),
    addRequest: db.prepare("INSERT INTO friend_requests (from_id, to_id) VALUES (?, ?) ON CONFLICT DO NOTHING"),
    dropRequest: db.prepare("DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)"),
    addFriend: db.prepare("INSERT INTO friends (user_id, friend_id) VALUES (?, ?) ON CONFLICT DO NOTHING"),
    dropFriend: db.prepare("DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)"),
    insert: db.prepare("INSERT INTO chat_messages (channel, user_id, body, at) VALUES (?, ?, ?, ?) RETURNING id"),
    history: db.prepare(`SELECT m.id, m.body AS text, m.at, ${PUBLIC} FROM chat_messages m JOIN users u ON u.id = m.user_id
      WHERE m.channel = ? ORDER BY m.id DESC LIMIT ${HISTORY}`),
    trim: db.prepare(`DELETE FROM chat_messages WHERE channel = 'general' AND id <= (
      SELECT id FROM chat_messages WHERE channel = 'general' ORDER BY id DESC LIMIT 1 OFFSET ${KEEP_GENERAL})`),
  };

  const streams = new Map();   // user id -> Set of open event streams
  const rates = new Map();     // "user:kind" -> { minute, count }
  const online = (id) => streams.has(id);

  function limited(userId, kind) {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${userId}:${kind}`;
    const rate = rates.get(key);
    if (!rate || rate.minute !== minute) { rates.set(key, { minute, count: 1 }); return false; }
    return ++rate.count > RATE[kind];
  }

  function emit(userId, event) {
    for (const res of streams.get(userId) ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  const emitAll = (event) => { for (const id of streams.keys()) emit(id, event); };
  const countOnline = () => emitAll({ type: "online", count: streams.size });
  const toFriends = async (userId, event) => { for (const f of await sql.friends.all(userId)) emit(f.id, event); };

  const person = (row) => row && { id: row.id, name: row.name, username: row.username, avatar: row.avatar ?? null };
  const dmChannel = (a, b) => `dm:${Math.min(a, b)}:${Math.max(a, b)}`;

  async function state(userId) {
    const [friends, incoming, outgoing] = await Promise.all([sql.friends.all(userId), sql.incoming.all(userId),
      sql.outgoing.all(userId)]);
    return {
      friends: friends.map((f) => ({ ...person(f), online: online(f.id) })),
      incoming: incoming.map(person),
      outgoing: outgoing.map(person),
      online: streams.size,
    };
  }
  const refresh = async (...ids) => { for (const id of ids) emit(id, { type: "friends", ...await state(id) }); };

  // "general" or "friend:<id>" (a friend of the user) -> the stored channel, or null.
  async function channelOf(userId, name) {
    if (name === "general") return "general";
    const friend = /^friend:(\d+)$/.exec(String(name))?.[1];
    if (friend && await sql.isFriend.get(userId, Number(friend))) return dmChannel(userId, Number(friend));
    return null;
  }

  function cleanText(text) {
    if (typeof text !== "string") return "";
    return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
  }

  // Returns true when the route was a social one (and the response was sent).
  return async function handleSocial(route, req, res, user, url) {
    if (!url.pathname.startsWith("/api/social/")) return false;

    if (route === "GET /api/social/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      const first = !online(user.id);
      if (first) streams.set(user.id, new Set());
      streams.get(user.id).add(res);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        const set = streams.get(user.id);
        set?.delete(res);
        if (set && set.size === 0) {
          streams.delete(user.id);
          background(toFriends(user.id, { type: "presence", id: user.id, online: false }), "social");
          countOnline();
        }
      });
      emit(user.id, { type: "friends", ...await state(user.id) });
      if (first) await toFriends(user.id, { type: "presence", id: user.id, online: true }), countOnline();
      return true;
    }

    if (route === "GET /api/social/state") return sendJson(res, 200, await state(user.id)), true;

    if (route === "GET /api/social/messages") {
      const channel = await channelOf(user.id, url.searchParams.get("channel"));
      if (!channel) return sendJson(res, 404, { error: "Unknown chat." }), true;
      const messages = (await sql.history.all(channel)).reverse().map((m) => ({ id: m.id, text: m.text, at: m.at, from: person(m) }));
      return sendJson(res, 200, { messages }), true;
    }

    if (route === "POST /api/social/messages") {
      const body = await readJson(req);
      const channel = await channelOf(user.id, body.channel);
      if (!channel) return sendJson(res, 404, { error: "Unknown chat." }), true;
      const text = cleanText(body.text);
      if (!text) return sendJson(res, 400, { error: "Empty message." }), true;
      if (limited(user.id, "message")) return sendJson(res, 429, { error: "Slow down a little." }), true;
      const at = Date.now();
      const { id } = await sql.insert.run(channel, user.id, text, at);
      const message = { id, text, at, from: person(await sql.user.get(user.id)) };
      if (channel === "general") {
        if (id % 100 === 0) await sql.trim.run();
        emitAll({ type: "message", channel: "general", message });
      } else {
        const other = Number(body.channel.slice("friend:".length));
        emit(user.id, { type: "message", channel: `friend:${other}`, message });
        emit(other, { type: "message", channel: `friend:${user.id}`, message });
      }
      return sendJson(res, 201, { message }), true;
    }

    if (req.method !== "POST") return false;
    const body = await readJson(req);

    // { username } or { id }: sends a request, or accepts the one that person already sent.
    if (route === "POST /api/social/friends/request") {
      if (limited(user.id, "request")) return sendJson(res, 429, { error: "Too many requests, wait a minute." }), true;
      const target = Number.isInteger(body.id) ? await sql.user.get(body.id)
        : typeof body.username === "string" && NAME_RE.test(body.username.trim()) ? await sql.byName.get(body.username.trim()) : undefined;
      if (!target) return sendJson(res, 404, { error: "No player with that username." }), true;
      if (target.id === user.id) return sendJson(res, 400, { error: "That's you!" }), true;
      if (await sql.isFriend.get(user.id, target.id)) return sendJson(res, 409, { error: "You are already friends." }), true;
      if (await sql.request.get(target.id, user.id)) {
        await sql.dropRequest.run(user.id, target.id, target.id, user.id);
        await sql.addFriend.run(user.id, target.id);
        await sql.addFriend.run(target.id, user.id);
        await refresh(user.id, target.id);
        return sendJson(res, 200, { status: "friends" }), true;
      }
      await sql.addRequest.run(user.id, target.id);
      await refresh(user.id, target.id);
      emit(target.id, { type: "request", from: person(await sql.user.get(user.id)) });
      return sendJson(res, 200, { status: "sent" }), true;
    }

    // { id, accept }: answers a request someone sent.
    if (route === "POST /api/social/friends/respond") {
      const from = Number(body.id);
      if (!Number.isInteger(from) || !await sql.request.get(from, user.id)) return sendJson(res, 404, { error: "No such request." }), true;
      await sql.dropRequest.run(from, user.id, user.id, from);
      if (body.accept === true) {
        await sql.addFriend.run(user.id, from);
        await sql.addFriend.run(from, user.id);
      }
      await refresh(user.id, from);
      return sendJson(res, 200, { ok: true }), true;
    }

    // { id }: cancels a request sent, or removes a friend.
    if (route === "POST /api/social/friends/remove") {
      const other = Number(body.id);
      if (!Number.isInteger(other)) return sendJson(res, 400, { error: "Unknown player." }), true;
      await sql.dropRequest.run(user.id, other, other, user.id);
      await sql.dropFriend.run(user.id, other, other, user.id);
      await refresh(user.id, other);
      return sendJson(res, 200, { ok: true }), true;
    }
    return false;
  };
}
