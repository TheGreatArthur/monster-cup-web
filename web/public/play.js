// Runs the player's ROM in EmulatorJS (melonDS core) and keeps the game's save (.sav) in sync with the server.
import { setupOnline } from "./online.js";
import { setupGifts } from "./gifts.js";
import { setupSocial, fillAvatar } from "./social.js";
import { setupSoundSettings, startVolume } from "./sound-settings.js";
import { setupHub } from "./hub.js";
import { playerRom } from "./rom.js";

const EJS_DATA = "https://cdn.emulatorjs.org/4.2.3/data/";
const SYNC_INTERVAL_MS = 15_000;
const PRESENCE_MS = 5_000;   // web/presence.js BEAT_MS: the admins' live page shows who is playing

// Hide every EmulatorJS control so the page shows only the game.
const HIDDEN_EMULATOR_BUTTONS = Object.fromEntries(
  ["playPause", "restart", "mute", "settings", "fullscreen", "saveState", "loadState", "screenRecord",
    "gamepad", "cheat", "volume", "saveSavFiles", "loadSavFiles", "quickSave", "quickLoad",
    "screenshot", "cacheManager", "exitEmulation", "netplay", "diskButton", "rightClick"]
    .map((name) => [name, false]),
);

let lastHash = null;   // hash of the save last stored on (or loaded from) the server
let syncing = false;

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Writes the server save into the emulator file system, then restarts so the game reads it at boot.
// The server gives new accounts a starter save, so there is always one, and the ROM
// (patches/skip_intro.json) boots straight into it: no logos, movie or title menu.
async function restoreSave() {
  const res = await fetch("/api/save");
  if (res.status === 409) {   // no starter picked yet
    location.href = "/starter";
    return;
  }
  if (!res.ok) throw new Error(`GET /api/save ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gm = window.EJS_emulator.gameManager;
  const file = gm.getSaveFilePath();
  gm.FS.mkdirTree(file.slice(0, file.lastIndexOf("/")));
  gm.FS.writeFile(file, bytes);
  gm.loadSaveFiles();
  gm.restart();
  lastHash = await sha256(bytes);
}

// Flushes the emulated save memory to its file and uploads it when it changed.
async function syncSave() {
  if (syncing || !window.EJS_emulator?.started) return;
  syncing = true;
  try {
    const gm = window.EJS_emulator.gameManager;
    gm.saveSaveFiles();
    const file = gm.getSaveFilePath();
    // The core only creates the file once the game writes its save memory (an in-game save).
    if (!gm.FS.analyzePath(file).exists) return;
    const bytes = gm.FS.readFile(file);
    const hash = await sha256(bytes);
    if (hash === lastHash) return;
    const res = await fetch("/api/save", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    if (res.status === 401) {
      location.href = "/";
      return;
    }
    if (!res.ok) throw new Error(`PUT /api/save ${res.status}`);
    lastHash = hash;
  } catch (err) {
    console.error(err);
  } finally {
    syncing = false;
  }
}

async function onGameStart() {
  // melonDS supports a mouse, so EmulatorJS locks the pointer on the first click and the cursor
  // disappears. The touch screen follows the cursor ("Touch" mode below): keep it visible.
  window.EJS_emulator.enableMouseLock = false;
  try {
    await restoreSave();
  } catch (err) {
    console.error(err);
  }
  setInterval(syncSave, SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") syncSave();
  });
}

// Tells the server this account is playing (game started or not, tab visible, a gift's mail);
// the answer says whether a gift waits, so it reaches the game within seconds.
function reportPresence(gifts) {
  const post = (url, body, extra = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), ...extra });
  const beat = async () => {
    const res = await post("/api/presence", { game: window.EJS_emulator?.started ? "running" : "loading",
      visible: document.visibilityState === "visible", gift: gifts.phase() });
    if (res.ok && (await res.json()).pending > 0) gifts.refresh();
  };
  beat().catch(() => {});
  setInterval(() => beat().catch(() => {}), PRESENCE_MS);
  window.addEventListener("pagehide", () => post("/api/presence/leave", {}, { keepalive: true }).catch(() => {}));
}

// EmulatorJS opens its own menu on a right click over the game (and the browser's menu would show
// otherwise): neither may appear. Capture runs before EmulatorJS's own listener.
function blockEmulatorMenu() {
  const game = document.getElementById("game");
  window.addEventListener("contextmenu", (e) => {
    if (!game.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
}

async function main() {
  const res = await fetch("/api/me");
  if (!res.ok) {
    location.href = "/";
    return;
  }
  const me = await res.json();
  document.getElementById("username").textContent = me.name;
  fillAvatar(document.getElementById("me-avatar"), me);
  document.getElementById("link-discord").hidden = !me.discordLogin || me.discord;
  blockEmulatorMenu();

  setupOnline({ syncSave });
  setupSocial(me);
  setupSoundSettings();
  const gifts = setupGifts();
  reportPresence(gifts);
  setupHub({ gifts, syncSave });
  document.getElementById("logout").addEventListener("click", async () => {
    await syncSave();
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    location.href = "/";
  });

  // The site serves no ROM: the player's own copy, modded in this browser (rom.js). The file name
  // is per user, as the emulator names its files after it.
  const rom = await playerRom(`digimon-u${me.id}.nds`);

  // EmulatorJS reads its configuration from these globals. The server save is restored at start.
  Object.assign(window, {
    EJS_player: "#game",
    EJS_core: "melonds",
    EJS_gameUrl: rom,
    EJS_gameName: "Digimon World Championship",
    EJS_pathtodata: EJS_DATA,
    EJS_language: "en-US",
    EJS_Buttons: HIDDEN_EMULATOR_BUTTONS,
    EJS_volume: startVolume(),   // the gear's master volume (sound-settings.js)
    // "Mouse" (the core default) moves a relative cursor; "Touch" maps the click to the
    // bottom screen position, which is what a player expects.
    // With the threaded core, the DS's 3D is drawn on its own thread.
    EJS_defaultOptions: { melonds_touch_mode: "Touch", lockMouse: "disabled",
      melonds_threaded_renderer: window.crossOriginIsolated ? "enabled" : "disabled" },
    EJS_backgroundColor: "#000000",
    EJS_startOnLoaded: true,
    // The threaded melonDS core: the DS's 3D and its emulation share the work over several CPU
    // cores. It needs the cross-origin isolation the server sets on /play.
    EJS_threads: window.crossOriginIsolated,
    EJS_onGameStart: onGameStart,
  });
  const loader = document.createElement("script");
  loader.src = `${EJS_DATA}loader.js`;
  document.body.append(loader);
}

main();
