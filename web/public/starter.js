// Starter selection: the 12 Baby I Digimon stand on a turning ring (top screen) and the game's
// message window asks for confirmation (bottom screen). Everything is drawn with graphics and
// fonts exported from the ROM (tools/export_starter_assets.py). The pick is sent to the server,
// which builds the account's first save with the DigiEgg hatching into that baby.
import { textWidth, drawText } from "./ds-text.js";

const ASSETS = "/game-assets/";
const W = 256;                    // one DS screen
const H = 192;
const PX = 2;                     // canvas pixels per DS pixel
const FRAME_MS = 1000 / 60;       // NANR durations are in 1/60 s
const RING = { x: 128, y: 100, rx: 112, ry: 34 };
const DRAG_PX_PER_ITEM = 44;

// Text colours: index 1 of the font is the letter, index 2 its shadow.
const WHITE = { 1: [248, 248, 248], 2: [72, 72, 80] };
const RED = { 1: [248, 88, 64], 2: [104, 24, 16] };
const GOLD = { 1: [255, 214, 32], 2: [122, 70, 0] };

const canvas = document.getElementById("screens");
const ctx = canvas.getContext("2d");
const errorEl = document.getElementById("error");

const img = {};
let manifest;
let babies = [];
let fonts = {};
let pos = 0;                      // ring rotation, in items (unwrapped); the front baby is round(pos)
let target = 0;
let mode = "choose";              // "choose" | "confirm" | "saving"
let drag = null;                  // { x, pos, moved, t, v }
let pressed = null;               // name of the button under the pointer
let last = performance.now();

const mod = (a, n) => ((a % n) + n) % n;
const front = () => mod(Math.round(target), babies.length);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image ${src}`));
    image.src = ASSETS + src;
  });
}

// --- game font (ds-text.js) ------------------------------------------------------

const drawLine = (font, runs, x, y) => drawText(ctx, font, runs, x, y);

// --- sprites -------------------------------------------------------------------

function frameAt(sprite, t) {
  const total = sprite.durations.reduce((a, b) => a + b, 0) * FRAME_MS;
  let left = t % total;
  for (let i = 0; i < sprite.durations.length; i++) {
    left -= sprite.durations[i] * FRAME_MS;
    if (left < 0) return i;
  }
  return 0;
}

// Draws a sprite frame with its feet at (x, y).
function drawSprite(sprite, t, x, y, scale) {
  const w = sprite.width * scale;
  const h = sprite.height * scale;
  ctx.drawImage(sprite.img, frameAt(sprite, t) * sprite.width, 0, sprite.width, sprite.height,
    x - w / 2, y - h, w, h);
}

// The gold button plate, stretched in the middle only so its rounded ends keep their shape.
function drawPlate(cx, cy, width) {
  const p = img.button;
  const end = 16;
  const x = Math.round(cx - width / 2);
  const y = Math.round(cy - p.height / 2);
  ctx.drawImage(p, 0, 0, end, p.height, x, y, end, p.height);
  ctx.drawImage(p, end, 0, p.width - 2 * end, p.height, x + end, y, width - 2 * end, p.height);
  ctx.drawImage(p, p.width - end, 0, end, p.height, x + width - end, y, end, p.height);
}

// --- layout of the bottom screen (DS coordinates, bottom screen origin) ---------------------

function buttons() {
  const a = manifest.window.anchors;
  if (mode === "choose") return [{ name: "ok", label: img.label_ok, x: a.ok[0], y: a.ok[1] }];
  if (mode === "confirm") {
    return [
      { name: "yes", label: img.label_yes, x: a.select_decide[0], y: a.select_decide[1] },
      { name: "no", label: img.label_no, x: a.select_cancel[0], y: a.select_cancel[1] },
    ];
  }
  return [];
}
const ARROWS = [{ name: "left", x: 26, y: 156, dir: -1 }, { name: "right", x: 230, y: 156, dir: 1 }];

function hitButton(x, y) {
  for (const b of buttons()) {
    if (Math.abs(x - b.x) <= img.button.width / 2 && Math.abs(y - b.y) <= img.button.height / 2) return b.name;
  }
  if (mode === "choose") {
    for (const a of ARROWS) if (Math.abs(x - a.x) <= 18 && Math.abs(y - a.y) <= 18) return a.name;
  }
  return null;
}

// --- drawing ---------------------------------------------------------------------

function ringItems() {
  const n = babies.length;
  return babies.map((baby, i) => {
    let d = mod(i - pos + n / 2, n) - n / 2;   // -n/2 .. n/2, 0 = front
    const a = (d / n) * Math.PI * 2;
    const depth = (Math.cos(a) + 1) / 2;          // 1 front .. 0 back
    return {
      baby, i, depth,
      x: RING.x + Math.sin(a) * RING.rx,
      y: RING.y + Math.cos(a) * RING.ry,
      scale: 1 + depth ** 3 * 2.2,   // only the front baby is shown big
    };
  }).sort((p, q) => p.depth - q.depth);
}

function drawTop(t) {
  ctx.drawImage(img.bg_top, 0, 0);
  drawLine(fonts.font, [["Choose your partner!", WHITE]], W / 2, 6);

  for (const it of ringItems()) {
    // Shadow on the floor, then the Digimon, darker the further back it stands.
    ctx.fillStyle = `rgba(0, 16, 48, ${0.25 + it.depth * 0.3})`;
    ctx.beginPath();
    ctx.ellipse(it.x, it.y, 5 * it.scale, 1.6 * it.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.filter = `brightness(${0.35 + it.depth * 0.65})`;
    const bob = it.depth > 0.98 && !drag ? Math.round(Math.sin(t / 180) * 1.5) : 0;
    drawSprite(it.baby, t + it.i * 137, it.x, it.y + bob, it.scale);
    ctx.filter = "none";
  }

  const baby = babies[front()];
  const plate = Math.max(img.button.width, textWidth(fonts.font, baby.name) + 36);
  drawPlate(W / 2, 160, plate);
  drawLine(fonts.font, [[baby.name, GOLD]], W / 2, 154);
  drawLine(fonts.font_small, [["Baby I", WHITE]], W / 2, 178);
}

function drawBottom(t) {
  ctx.drawImage(img.bg_bottom, 0, 0);
  const win = manifest.window;
  ctx.drawImage(img.window, win.x, win.y);

  const name = babies[front()].name;
  const lines = {
    choose: [[["Which Digimon will hatch", WHITE]], [["from your DigiEgg?", WHITE]]],
    confirm: [[["Your DigiEgg will hatch", WHITE]], [["into ", WHITE], [name, RED], ["! OK?", WHITE]]],
    saving: [[["Your DigiEgg is ready!", WHITE]], [["Here comes ", WHITE], [name, RED], ["...", WHITE]]],
  }[mode];
  const [mx, my] = win.anchors.message;
  lines.forEach((runs, k) => drawLine(fonts.font, runs, mx, my - 13 + k * 15));

  for (const b of buttons()) {
    const down = pressed === b.name ? 1 : 0;
    ctx.drawImage(img.button, Math.round(b.x - img.button.width / 2), Math.round(b.y - img.button.height / 2) + down);
    ctx.drawImage(b.label, Math.round(b.x - b.label.width / 2), Math.round(b.y - b.label.height / 2) + down);
  }

  if (mode === "choose") {
    const nudge = Math.round(Math.sin(t / 160) * 2);
    for (const a of ARROWS) {
      // The game's red arrow points down: turn it to point left or right.
      ctx.save();
      ctx.translate(a.x + a.dir * (nudge + (pressed === a.name ? 2 : 0)), a.y);
      ctx.rotate(-a.dir * Math.PI / 2);
      ctx.drawImage(img.arrow, -img.arrow.width / 2, -img.arrow.height / 2);
      ctx.restore();
    }
    drawLine(fonts.font_small, [["Slide to choose", WHITE]], W / 2, 131);
  }
  // The DigiEgg waits between the arrows, shaking faster once a baby is picked.
  drawSprite(manifest.egg, mode === "choose" ? t : t * 3, W / 2, 182, 2);
}

function draw(t) {
  ctx.setTransform(PX, 0, 0, PX, 0, 0);
  ctx.imageSmoothingEnabled = false;
  drawTop(t);
  ctx.save();
  ctx.translate(0, H);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  drawBottom(t);
  ctx.restore();
}

function tick(now) {
  const dt = Math.min(64, now - last);
  last = now;
  if (!drag) pos += (target - pos) * (1 - Math.pow(0.82, dt / FRAME_MS));
  draw(now);
  requestAnimationFrame(tick);
}

// --- input -------------------------------------------------------------------------

function step(dir) {
  if (mode !== "choose") return;
  target = Math.round(target) + dir;
}

async function press(name) {
  errorEl.textContent = "";
  if (name === "left") step(-1);
  else if (name === "right") step(1);
  else if (name === "ok") mode = "confirm";
  else if (name === "no") mode = "choose";
  else if (name === "yes") await choose();
}

async function choose() {
  mode = "saving";
  try {
    const res = await fetch("/api/starter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ species: babies[front()].species }),
    });
    if (res.ok || res.status === 409) {
      setTimeout(() => { location.href = "/play"; }, 900);
      return;
    }
    errorEl.textContent = (await res.json()).error ?? `Error ${res.status}`;
  } catch (err) {
    console.error(err);
    errorEl.textContent = "Could not save your partner. Try again.";
  }
  mode = "confirm";
}

// Pointer position in DS pixels over both screens (0..256, 0..384).
function toScreen(e) {
  // Inside the frame's border.
  const box = canvas.getBoundingClientRect();
  const x = e.clientX - box.left - canvas.clientLeft, y = e.clientY - box.top - canvas.clientTop;
  return [(x / canvas.clientWidth) * W, (y / canvas.clientHeight) * H * 2];
}

// The ring baby drawn under (x, y) on the top screen, front-most first.
function babyAt(x, y) {
  for (const it of ringItems().reverse()) {
    const w = (it.baby.width * it.scale) / 2;
    if (Math.abs(x - it.x) <= w && y <= it.y && y >= it.y - it.baby.height * it.scale) return it;
  }
  return null;
}

canvas.addEventListener("pointerdown", (e) => {
  const [x, y] = toScreen(e);
  canvas.setPointerCapture(e.pointerId);
  pressed = y >= H ? hitButton(x, y - H) : null;
  if (!pressed && mode === "choose") drag = { x, pos, moved: 0, t: performance.now(), v: 0 };
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const [x] = toScreen(e);
  const now = performance.now();
  const next = drag.pos - (x - drag.x) / DRAG_PX_PER_ITEM;
  drag.v = (next - pos) / Math.max(1, now - drag.t);
  drag.t = now;
  drag.moved = Math.max(drag.moved, Math.abs(x - drag.x));
  pos = next;
});

canvas.addEventListener("pointerup", (e) => {
  const [x, y] = toScreen(e);
  if (pressed) {
    const name = pressed;
    pressed = null;
    if (y >= H && hitButton(x, y - H) === name) press(name);
    return;
  }
  if (!drag) return;
  if (drag.moved < 3) {
    // A tap on a baby turns the ring to it.
    const it = y < H ? babyAt(x, y) : null;
    if (it) target = Math.round(pos) + (mod(it.i - Math.round(pos) + babies.length / 2, babies.length) - babies.length / 2);
  } else {
    target = Math.round(pos + drag.v * 120);   // a quick flick carries on a little
  }
  drag = null;
});

canvas.addEventListener("pointercancel", () => {
  if (drag) target = Math.round(pos);
  drag = null;
  pressed = null;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    step(e.key === "ArrowRight" ? 1 : -1);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (mode === "choose") press("ok");
    else if (mode === "confirm") press("yes");
  } else if (e.key === "Escape" || e.key === "Backspace") {
    if (mode === "confirm") press("no");
  }
});

// The page's bar: the player's name and logout, as on the play page.
async function setupBar() {
  const res = await fetch("/api/me");
  if (res.ok) document.getElementById("username").textContent = (await res.json()).username;
  document.getElementById("logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    location.href = "/";
  });
}

async function main() {
  setupBar();
  const res = await fetch(`${ASSETS}manifest.json`);
  if (res.status === 401) {
    location.href = "/";
    return;
  }
  if (!res.ok) {
    errorEl.textContent = "Game graphics missing: run tools/export_starter_assets.py.";
    return;
  }
  manifest = await res.json();
  const withImage = async (s) => ({ ...s, img: await loadImage(s.sprite) });
  babies = await Promise.all(manifest.babies.map(withImage));
  manifest.egg = await withImage(manifest.egg);
  manifest.window.img = await loadImage(manifest.window.image);
  img.window = manifest.window.img;
  for (const key of ["bg_top", "bg_bottom", "button", "label_ok", "label_yes", "label_no", "arrow"]) {
    img[key] = await loadImage(manifest[key]);
  }
  for (const key of ["font", "font_small"]) {
    const m = await (await fetch(ASSETS + manifest[key].metrics)).json();
    fonts[key] = { m, image: await loadImage(manifest[key].image), tints: {} };
  }
  // Start on a random baby so no species is favoured by default.
  target = pos = crypto.getRandomValues(new Uint32Array(1))[0] % babies.length;
  requestAnimationFrame(tick);
}

main();
