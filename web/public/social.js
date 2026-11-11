// The play page's side panel: general chat, a private chat per friend, friend requests and the
// ranked ladder, all live over /api/social/events (web/social.js).
const $ = (id) => document.getElementById(id);
const LADDER_MS = 60_000;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// A Discord avatar (served by our server), or the first letter of the name.
export function avatar(person, big = false) {
  const box = el("span", { className: `avatar${big ? " big" : ""}`, ariaHidden: "true" });
  fillAvatar(box, person);
  return box;
}
export function fillAvatar(box, person) {
  box.replaceChildren();
  box.style.setProperty("--hue", String((person.id * 47) % 360));
  const letter = () => { box.textContent = (person.name ?? "?").trim().charAt(0).toUpperCase() || "?"; };
  if (!person.avatar) return letter();
  const img = el("img", { src: person.avatar, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", letter, { once: true });
  box.append(img);
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(async (res) => ({ ok: res.ok, ...(await res.json().catch(() => ({}))) }));

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function setupSocial(me) {
  const panel = $("social");
  const state = { friends: [], incoming: [], outgoing: [], online: 0 };
  const unread = new Map();          // channel -> count
  const loaded = new Map();          // channel -> messages[]
  let channel = "general";
  let tab = "chat";
  let ladderTimer = null;

  // Typing in the panel must not press the game's buttons: EmulatorJS listens on the document.
  for (const target of [panel, $("player-card")]) {
    for (const type of ["keydown", "keyup", "keypress"]) target.addEventListener(type, (e) => e.stopPropagation());
  }
  $("my-username").textContent = me.username;

  // --- tabs ---------------------------------------------------------------------------------
  const tabs = [...panel.querySelectorAll("[data-tab]")];
  function showTab(name) {
    tab = name;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const p of panel.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
    clearInterval(ladderTimer);
    if (name === "ranking") { loadLadder(); ladderTimer = setInterval(loadLadder, LADDER_MS); }
    if (name === "chat") { markRead(channel); scrollDown(); }
    badges();
  }
  for (const t of tabs) t.addEventListener("click", () => showTab(t.dataset.tab));

  function badges() {
    const chatUnread = [...unread.values()].reduce((a, b) => a + b, 0);
    setBadge(tabs[0], chatUnread);
    setBadge(tabs[1], state.incoming.length);
  }
  function setBadge(button, n) {
    const badge = button.querySelector(".badge");
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? "99+" : String(n);
  }

  // --- chat -----------------------------------------------------------------------------------
  const friendOf = (ch) => state.friends.find((f) => `friend:${f.id}` === ch);

  function renderChannels() {
    if (channel !== "general" && !friendOf(channel)) channel = "general";
    const chip = (ch, label, extra) => {
      const n = unread.get(ch) ?? 0;
      const b = el("button", { type: "button", role: "tab", className: "chip", ariaSelected: String(ch === channel) },
        extra ?? null, el("span", { textContent: label }), n ? el("span", { className: "badge", textContent: String(n) }) : null);
      b.addEventListener("click", () => openChannel(ch));
      return b;
    };
    $("channels").replaceChildren(
      chip("general", "General", el("span", { className: "count", textContent: String(state.online), title: "Players online" })),
      ...state.friends.map((f) => chip(`friend:${f.id}`, f.name, el("span", { className: `dot${f.online ? " on" : ""}` }))));
  }

  function messageItem(m) {
    const mine = m.from.id === me.id;
    const name = el("button", { type: "button", className: "name", textContent: m.from.name });
    name.addEventListener("click", () => openCard(m.from));
    return el("li", { className: mine ? "mine" : "" }, avatar(m.from),
      el("div", { className: "bubble" }, el("div", { className: "meta" }, name, el("time", { textContent: time(m.at) })),
        el("p", { textContent: m.text })));
  }

  function renderMessages() {
    const list = loaded.get(channel) ?? [];
    const friend = friendOf(channel);
    $("messages").replaceChildren(...(list.length ? list.map(messageItem)
      : [el("li", { className: "empty", textContent: friend ? `This is the start of your chat with ${friend.name}.` : "No messages yet. Say hi!" })]));
    $("chat-input").placeholder = friend ? `Message ${friend.name}` : "Say hi to the arena";
    scrollDown();
  }
  const scrollDown = () => { const box = $("messages"); box.scrollTop = box.scrollHeight; };

  async function openChannel(ch) {
    channel = ch;
    markRead(ch);
    renderChannels();
    if (!loaded.has(ch)) {
      const res = await fetch(`/api/social/messages?channel=${encodeURIComponent(ch)}`);
      loaded.set(ch, res.ok ? (await res.json()).messages : []);
    }
    if (channel === ch) renderMessages();
  }
  function markRead(ch) { unread.delete(ch); badges(); }

  $("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text) return;
    $("chat-error").textContent = "";
    input.value = "";
    const res = await post("/api/social/messages", { channel, text }).catch(() => ({ ok: false, error: "Server unreachable." }));
    if (!res.ok) { $("chat-error").textContent = res.error ?? "Not sent."; input.value = text; }
  });

  function onMessage(ch, message) {
    const list = loaded.get(ch);
    if (list && !list.some((m) => m.id === message.id)) list.push(message);
    const visible = tab === "chat" && ch === channel && !document.hidden;
    if (!visible && message.from.id !== me.id) unread.set(ch, (unread.get(ch) ?? 0) + 1);
    if (ch === channel) renderMessages();
    renderChannels();
    badges();
  }

  // --- friends --------------------------------------------------------------------------------
  function personRow(p, ...actions) {
    const who = el("button", { type: "button", className: "who" }, avatar(p),
      el("span", {}, el("b", { textContent: p.name }), el("small", { textContent: `@${p.username}` })));
    who.addEventListener("click", () => openCard(p));
    return el("li", {}, who, el("span", { className: "actions" }, ...actions));
  }
  function action(label, handler, primary = false) {
    const b = el("button", { type: "button", className: primary ? "primary small" : "ghost small", textContent: label });
    b.addEventListener("click", async () => { b.disabled = true; await handler(); b.disabled = false; });
    return b;
  }

  function renderFriends() {
    $("incoming-group").hidden = state.incoming.length === 0;
    $("incoming").replaceChildren(...state.incoming.map((p) => personRow(p,
      action("Accept", () => post("/api/social/friends/respond", { id: p.id, accept: true }), true),
      action("Decline", () => post("/api/social/friends/respond", { id: p.id, accept: false })))));
    $("no-friends").hidden = state.friends.length > 0;
    $("friend-list").replaceChildren(...[...state.friends].sort((a, b) => b.online - a.online).map((p) => {
      const row = personRow(p, action("Chat", async () => { showTab("chat"); await openChannel(`friend:${p.id}`); }, true));
      row.querySelector(".avatar").append(el("span", { className: `dot${p.online ? " on" : ""}`, title: p.online ? "Online" : "Offline" }));
      return row;
    }));
    $("outgoing-group").hidden = state.outgoing.length === 0;
    $("outgoing").replaceChildren(...state.outgoing.map((p) => personRow(p,
      action("Cancel", () => post("/api/social/friends/remove", { id: p.id })))));
    renderChannels();
    badges();
  }

  $("add-friend").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("friend-name");
    const res = await post("/api/social/friends/request", { username: input.value.trim() }).catch(() => ({ ok: false, error: "Server unreachable." }));
    const result = $("friend-result");
    result.className = res.ok ? "hint ok" : "hint error";
    result.textContent = res.ok ? (res.status === "friends" ? "You are now friends!" : "Request sent.") : res.error;
    if (res.ok) input.value = "";
  });

  // --- player card (a name tapped in the chat, the ranking or a list) -------------------------
  const card = $("player-card");
  function openCard(p) {
    fillAvatar($("card-avatar"), p);
    $("card-name").textContent = p.name;
    $("card-username").textContent = `@${p.username}`;
    const button = $("card-action");
    const friend = state.friends.some((f) => f.id === p.id);
    const sent = state.outgoing.some((f) => f.id === p.id);
    const received = state.incoming.some((f) => f.id === p.id);
    button.hidden = p.id === me.id || sent;
    $("card-status").textContent = p.id === me.id ? "That's you!" : sent ? "Friend request sent." : friend ? "You are friends." : "";
    button.textContent = friend ? "Send a message" : received ? "Accept request" : "Add friend";
    button.onclick = async () => {
      if (friend) { card.close(); showTab("chat"); await openChannel(`friend:${p.id}`); return; }
      button.disabled = true;
      const res = await post("/api/social/friends/request", { id: p.id });
      button.disabled = false;
      $("card-status").textContent = res.ok ? (res.status === "friends" ? "You are now friends!" : "Friend request sent.") : res.error;
      button.hidden = res.ok;
    };
    card.showModal();
  }
  card.addEventListener("click", (e) => { if (e.target === card) card.close(); });

  // --- ranking --------------------------------------------------------------------------------
  async function loadLadder() {
    const res = await fetch("/api/online/ladder").catch(() => null);
    if (!res?.ok) return;
    const { ladder, me: mine } = await res.json();
    $("no-ladder").hidden = ladder.length > 0;
    $("ladder").replaceChildren(...ladder.map((p, i) => {
      const who = el("button", { type: "button", className: "who" }, avatar(p),
        el("span", {}, el("b", { textContent: p.name }), el("small", { textContent: `${p.wins} W · ${p.losses} L` })));
      who.addEventListener("click", () => openCard(p));
      return el("li", { className: `${i < 3 ? `top top${i + 1}` : ""}${p.id === me.id ? " me" : ""}` },
        el("span", { className: "place", textContent: String(i + 1) }), who, el("span", { className: "rating", textContent: String(p.rating) }));
    }));
    const place = ladder.findIndex((p) => p.id === me.id);
    $("my-rank").textContent = place >= 0 ? `You are #${place + 1} with ${mine.rating} points.`
      : `Your rating: ${mine.rating}. Play ranked battles to enter the ladder.`;
  }

  // --- live events ----------------------------------------------------------------------------
  function applyState(next) {
    Object.assign(state, { friends: next.friends, incoming: next.incoming, outgoing: next.outgoing, online: next.online });
    renderFriends();
  }
  let retry = 1000;
  function connect() {
    const source = new EventSource("/api/social/events");
    source.onopen = () => { retry = 1000; };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "friends") applyState(event);
      else if (event.type === "presence") {
        const f = state.friends.find((p) => p.id === event.id);
        if (f) { f.online = event.online; renderFriends(); }
      } else if (event.type === "online") { state.online = event.count; renderChannels(); }
      else if (event.type === "message") onMessage(event.channel, event.message);
    };
    source.onerror = () => {
      source.close();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    };
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && tab === "chat") markRead(channel); });

  connect();
  openChannel("general");
}
