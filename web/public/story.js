// The story intro a new account watches once, before the starter wheel: what a DigiTamer has to
// do, and who waits at the end, the King of Digimon "TheGreatArthur", shown winning the final of
// the Championship. Both DS screens are drawn with the game's own graphics and fonts
// (tools/export_starter_assets.py, export_site_assets.py, export_story_assets.py): the top screen
// plays the scenes, the bottom one tells the story in the game's message window.
import { textWidth, drawText } from "./ds-text.js";

const ASSETS = "/game-assets/";
const W = 256;                    // one DS screen
const H = 192;
const PX = 2;                     // canvas pixels per DS pixel
const FRAME_MS = 1000 / 60;       // the game's animation durations are in 1/60 s
const TYPE_MS = 22;               // per letter typed in the window
const READ_MS = 2200;             // a typed page stays at least this long, plus READ_PER_CHAR_MS a letter
const READ_PER_CHAR_MS = 30;
const FADE_MS = 450;
const LINE_MAX = 200;             // text width inside the window

// Text colours: index 1 of the font is the letter, index 2 its shadow.
const WHITE = { 1: [248, 248, 248], 2: [72, 72, 80] };
const GOLD = { 1: [255, 214, 32], 2: [122, 70, 0] };
const RED = { 1: [248, 88, 64], 2: [104, 24, 16] };

// The story: the pages of the bottom window, each over the top-screen scene it plays with.
// *Words* are gold. A page without text is the scene alone: the final, until it is won. With
// `reveal`, the King's name appears in large letters over the scene.
const STORY = [
  { scene: "title", text: "Welcome to the Digital World, where Digimon and their Tamers battle for glory." },
  { scene: "title", text: "You are a DigiTamer. Your goal: win the *Digimon World Championship*..." },
  { scene: "title", text: "...and climb to the very top of the *Online Arena* ranking!" },
  { scene: "training", text: "Train your Digimon day after day. Make them stronger, help them evolve..." },
  { scene: "training", text: "...and defeat every Digimon team that stands in your way." },
  { scene: "king", text: "But at the top of the Championship, one Tamer reigns over them all..." },
  { scene: "king", text: "The King of Digimon: *TheGreatArthur*!", reveal: true },
  { scene: "king", text: "Legends have tried to dethrone him. None of them made it." },
  { scene: "battle" },
  { scene: "battle", text: "*TheGreatArthur* is the last wall between you and the crown." },
  { scene: "egg", text: "Your journey starts today, with a single DigiEgg." },
  { scene: "egg", text: "Raise it well, Tamer. The King is waiting for you!" },
];
const DEV_TEAM = "TheGreatArthur";
const RIVAL_TEAM = "Legends";

const canvas = document.getElementById("screens");
const ctx = canvas.getContext("2d");
const errorEl = document.getElementById("error");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const img = {};
let manifest, story, fonts = {};
let fighters = {};                // sprite -> { ...story.json entry, img, white }
let step = -1, stepT = 0, typed = 0, lines = [], chars = 0;
let scene = null;                 // { name, t, actors, ... } of the scene playing
let fade = null;                  // { t, next }: out to black, change step, back in
let finished = false;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image ${src}`));
    image.src = ASSETS + src;
  });
}

// A copy of a sprite sheet in plain white: the flash of a Digimon taking a hit.
function whiteSheet(image) {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  const g = c.getContext("2d");
  g.drawImage(image, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// --- text ------------------------------------------------------------------------

// Splits a page into lines of [text, tint] runs no wider than LINE_MAX; *words* are gold.
function wrap(text) {
  // A word is a list of runs: a gold name keeps the punctuation written right after it.
  const words = [];
  let glue = false;
  text.split("*").forEach((part, k) => {
    const tint = k % 2 ? GOLD : WHITE;
    part.split(" ").forEach((piece, i) => {
      if (!piece) return;
      if (i === 0 && glue && words.length) words.at(-1).push([piece, tint]);
      else words.push([[piece, tint]]);
    });
    glue = part !== "" && !part.endsWith(" ");
  });
  const out = [];
  let line = [], width = 0;
  for (const word of words) {
    const w = word.reduce((s, [t]) => s + textWidth(fonts.font, t), 0);
    const space = textWidth(fonts.font, " ");
    if (line.length && width + space + w > LINE_MAX) {
      out.push(line);
      line = [];
      width = 0;
    }
    if (line.length) {
      line.push([" ", WHITE]);
      width += space;
    }
    line.push(...word);
    width += w;
  }
  if (line.length) out.push(line);
  return out;
}

// The first n letters of a line's runs.
function firstLetters(runs, n) {
  const out = [];
  for (const [text, tint] of runs) {
    if (n <= 0) break;
    out.push([text.slice(0, n), tint]);
    n -= text.length;
  }
  return out;
}

// Large text on the top screen (twice the font's size), centred on x.
function drawBig(runs, x, y, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.scale(2, 2);
  drawText(ctx, fonts.font, runs, x / 2, y / 2);
  ctx.restore();
}

// --- Digimon on the field ----------------------------------------------------------

const LOOPING = new Set(["idle", "run", "win"]);

function actor(sprite, x, y, { flip = false, zoom = 1, hp = 0 } = {}) {
  return { f: fighters[sprite], x, y, flip, zoom, move: "idle", moveT: 0, alpha: 1, flashT: Infinity,
    hp, maxHp: hp, tween: null };
}

function play(a, move) {
  a.move = move;
  a.moveT = 0;
}

// Milliseconds from the start of a move to its last frame (the strike of an attack).
const strikeMs = (a, move) => a.f.moves[move].durations.slice(0, -1).reduce((s, d) => s + d, 0) * FRAME_MS;

function frameOf(a) {
  const durations = a.f.moves[a.move].durations;
  const total = durations.reduce((s, d) => s + d, 0) * FRAME_MS;
  let t = LOOPING.has(a.move) ? a.moveT % total : Math.min(a.moveT, total - 1);
  for (let i = 0; i < durations.length; i++) {
    t -= durations[i] * FRAME_MS;
    if (t < 0) return i;
  }
  return durations.length - 1;
}

function moveTo(a, x, y, ms) {
  a.tween = { x0: a.x, y0: a.y, x, y, t: 0, ms };
}

function drawActor(a, at = a) {
  const { width: w, height: h, anchor, moves } = a.f;
  const row = moves[a.move].row, frame = frameOf(a);
  ctx.save();
  ctx.globalAlpha = a.alpha;
  ctx.translate(Math.round(at.x), Math.round(at.y));
  ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(6, w * 0.22) * a.zoom, 2.5 * a.zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.scale(a.flip ? -a.zoom : a.zoom, a.zoom);   // the sprites face left: flipped, they face right
  ctx.drawImage(a.f.img, frame * w, row * h, w, h, -anchor[0], -anchor[1], w, h);
  // The game flashes a Digimon white when it is hit.
  if (a.flashT < 320 && Math.floor(a.flashT / 80) % 2 === 0) {
    ctx.drawImage(a.f.white, frame * w, row * h, w, h, -anchor[0], -anchor[1], w, h);
  }
  ctx.restore();
}

function drawHpBar(a) {
  const x = Math.round(a.x - 12), y = Math.round(a.y + 4);
  const k = Math.max(0, a.hp / a.maxHp);
  ctx.fillStyle = "rgba(0, 8, 32, 0.8)";
  ctx.fillRect(x - 1, y - 1, 26, 5);
  ctx.fillStyle = k > 0.5 ? "#38e060" : k > 0.2 ? "#f8d020" : "#f84040";
  ctx.fillRect(x, y, Math.round(24 * k), 3);
}

// A glowing shot flying from a to b; on arrival, `hit`.
function shoot(a, b, color, ms, hit) {
  const from = { x: a.x + (a.flip ? 18 : -18) * a.zoom, y: a.y - a.f.anchor[1] * 0.55 * a.zoom };
  scene.shots.push({ from, to: { x: b.x, y: b.y - b.f.anchor[1] * 0.5 * b.zoom }, color, t: 0, ms, hit });
}

function drawShot(s) {
  const k = Math.min(1, s.t / s.ms);
  for (let i = 0; i < 5; i++) {   // the head and its fading trail
    const kk = Math.max(0, k - i * 0.06);
    const x = s.from.x + (s.to.x - s.from.x) * kk, y = s.from.y + (s.to.y - s.from.y) * kk;
    const r = 6 - i;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255, 255, 255, ${1 - i * 0.18})`);
    g.addColorStop(0.45, s.color.replace("A", String(0.9 - i * 0.15)));
    g.addColorStop(1, s.color.replace("A", "0"));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// b takes a hit: white flash, the damage in red above it, and a knock-out once its HP is gone.
function hit(b, damage, { shake = 0 } = {}) {
  b.flashT = 0;
  b.hp = Math.max(0, b.hp - damage);
  scene.pops.push({ x: b.x, y: b.y - b.f.anchor[1] * b.zoom - 4, text: String(damage), t: 0 });
  if (shake && !reduceMotion) scene.shake = shake;
  if (b.hp > 0) {
    play(b, "hit");
    later(380, () => play(b, "idle"));
    return;
  }
  play(b, "knock");
  moveTo(b, b.x + (b.flip ? -14 : 14), b.y, 260);
  later(320, () => play(b, "ko"));
  later(900, () => { b.alpha = 0.55; });
}

// a attacks b with `move`: from where it stands with a shot, or after a dash for a close attack.
function attack(a, b, move, { damage, shot = null, dash = false, shots = 1, shake = 0 }) {
  const back = { x: a.x, y: a.y };
  const go = dash ? 380 : 0;
  if (dash) {
    play(a, "run");
    moveTo(a, b.x + (a.flip ? -40 : 40) * b.zoom, b.y, go);
  }
  later(go, () => play(a, move));
  const strike = go + strikeMs(a, move);
  if (!shot) {
    later(strike, () => hit(b, damage, { shake }));
  } else {
    for (let i = 0; i < shots; i++) {
      const last = i === shots - 1;
      later(strike + i * 140, () => shoot(a, b, shot, 280, () => hit(b, last ? damage : 0, { shake: last ? shake : 0 })));
    }
  }
  const done = strike + (shot ? shots * 140 + 320 : 260);
  later(done, () => {
    if (!dash) return play(a, "idle");
    play(a, "run");
    moveTo(a, back.x, back.y, go);
    later(go, () => play(a, "idle"));
  });
}

// --- scenes ------------------------------------------------------------------------

// Runs fn `ms` after now in the scene playing.
function later(ms, fn) {
  scene.timers.push({ at: scene.t + ms, fn });
}

function newScene(name) {
  scene = { name, t: 0, actors: [], shots: [], pops: [], timers: [], shake: 0 };
  SCENES[name].enter?.();
}

const field = (key, ox, oy) => ctx.drawImage(img[key], ox, oy, W, H, 0, 0, W, H);

// Light rays turning slowly around (x, y).
function rays(x, y, t, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t / 4000);
  ctx.fillStyle = color;
  for (let i = 0; i < 12; i++) {
    ctx.rotate(Math.PI / 6);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-10, -260);
    ctx.lineTo(10, -260);
    ctx.fill();
  }
  ctx.restore();
}

const SCENES = {
  // The title screen's stadium; the logo comes down with a shine running over it.
  title: {
    drawTop(t) {
      ctx.drawImage(img.arena, 0, 0);
      const k = Math.min(1, t / 1400);
      const logo = img.logo;
      const y = Math.round(8 - (1 - k) * 14);
      const shine = img.logoShine.getContext("2d");
      shine.clearRect(0, 0, logo.width, logo.height);
      shine.globalCompositeOperation = "source-over";
      shine.drawImage(logo, 0, 0);
      shine.globalCompositeOperation = "source-atop";
      const sx = ((t % 3200) / 3200) * (logo.width + 120) - 60;
      const g = shine.createLinearGradient(sx - 30, 0, sx + 30, 0);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      shine.fillStyle = g;
      shine.fillRect(0, 0, logo.width, logo.height);
      ctx.globalAlpha = k;
      ctx.drawImage(img.logoShine, Math.round((W - logo.width) / 2), y);
      ctx.globalAlpha = 1;
      if (t > 1200) drawBig([["Online Arena", GOLD]], W / 2, 134, Math.min(1, (t - 1200) / 600));
    },
  },

  // Two Rookies sparring on a grass field, again and again.
  training: {
    enter() {
      const agu = actor("m201_agumon", 82, 128, { flip: true, zoom: 2, hp: 1 });
      const gabu = actor("m208_gabumon", 174, 128, { zoom: 2, hp: 1 });
      scene.actors.push(agu, gabu);
      const round = () => {
        later(700, () => attack(agu, gabu, "atk2", { damage: 0, shot: "rgba(255, 120, 24, A)" }));
        later(2300, () => attack(gabu, agu, "atk1", { damage: 0, dash: true }));
        later(3900, round);
      };
      round();
    },
    drawTop() {
      field("field_grass", 0, 60);
    },
  },

  // Night falls on the arena; the King's three Digimon appear one by one in pillars of light.
  king: {
    enter() {
      const team = [
        actor("m538_apollomon", 58, 150, { flip: true }),
        actor("m527_mugendramon", 128, 124),
        actor("m539_dianamon", 198, 150),
      ];
      team.forEach((a, i) => {
        a.alpha = 0;
        a.shownAt = 500 + i * 800;
        later(a.shownAt, () => { a.alpha = 1; a.flashT = 0; });
      });
      scene.actors.push(...team);
    },
    drawTop(t) {
      field("field_stone", 64, 48);
      ctx.fillStyle = "rgba(0, 4, 24, 0.68)";
      ctx.fillRect(0, 0, W, H);
      for (const a of scene.actors) {
        const k = Math.max(0, Math.min(1, (t - a.shownAt) / 500));
        if (!k) continue;
        const g = ctx.createLinearGradient(0, 0, 0, a.y);
        g.addColorStop(0, "rgba(255, 230, 140, 0)");
        g.addColorStop(1, `rgba(255, 230, 140, ${0.32 * k})`);
        ctx.fillStyle = g;
        ctx.fillRect(a.x - 24, 0, 48, a.y + 3);
      }
    },
    drawOver(t) {
      for (const a of scene.actors) {
        if (t < a.shownAt) continue;
        drawText(ctx, fonts.font_small, [[a.f.name, GOLD]], a.x, a.y + 6);
        // The white of the apparition fades out.
        const k = 1 - (t - a.shownAt) / 600;
        if (k > 0) {
          ctx.fillStyle = `rgba(255, 255, 255, ${k * 0.6})`;
          ctx.fillRect(0, 0, W, H);
        }
      }
      if (scene.revealAt !== undefined) drawBig([[DEV_TEAM, GOLD]], W / 2, 10, Math.min(1, (t - scene.revealAt) / 600));
    },
  },

  // The final of the Championship: TheGreatArthur's team against three legendary Megas.
  battle: {
    length: 12500,                // then the next page, over the winners
    enter() {
      const hp = 520;
      const dev = [
        actor("m538_apollomon", 66, 92, { flip: true, hp }),
        actor("m539_dianamon", 44, 136, { flip: true, hp }),
        actor("m527_mugendramon", 74, 182, { flip: true, hp }),
      ];
      const rivals = [
        actor("m503_warglaymon", 192, 92, { hp }),
        actor("m529_metalgarurumon_va", 214, 136, { hp }),
        actor("m541_dukemon", 186, 182, { hp }),
      ];
      scene.actors.push(...dev, ...rivals);
      scene.dev = dev;
      scene.rivals = rivals;
      scene.timer = 120;
      // Both teams run in from the sides.
      for (const a of [...dev, ...rivals]) {
        const x = a.x;
        a.x += a.flip ? -110 : 110;
        play(a, "run");
        moveTo(a, x, a.y, 1100);
        later(1100, () => play(a, "idle"));
      }
      const [apollo, diana, mugen] = dev, [war, metal, gallant] = rivals;
      later(2300, () => attack(war, apollo, "atk1", { damage: 34, dash: true, shake: 2 }));
      later(3500, () => attack(metal, diana, "atk2", { damage: 41, shot: "rgba(90, 200, 255, A)" }));
      later(4500, () => attack(gallant, mugen, "atk1", { damage: 29, dash: true, shake: 2 }));
      later(5900, () => attack(apollo, war, "atk1", { damage: hp, shot: "rgba(255, 110, 20, A)", shake: 4 }));
      later(7100, () => attack(diana, metal, "atk2", { damage: hp, shot: "rgba(200, 220, 255, A)", shake: 4 }));
      later(8300, () => attack(mugen, gallant, "atk4", { damage: hp, shot: "rgba(255, 220, 60, A)", shots: 4, shake: 5 }));
      later(10200, () => {
        scene.won = scene.t;
        for (const a of dev) play(a, "win");
      });
    },
    update() {
      if (!scene.won) scene.timer = Math.max(0, 120 - Math.floor(scene.t / 110));
    },
    drawTop() {
      field("field_stone", 64, 48);
    },
    drawOver(t) {
      if (t > 1300 && t < 2300) drawBig([["FIGHT!", RED]], W / 2, 70, 1 - Math.max(0, (t - 2000) / 300));
      if (scene.won) {
        const k = Math.min(1, (t - scene.won) / 400);
        ctx.fillStyle = `rgba(0, 8, 32, ${0.55 * k})`;
        ctx.fillRect(0, 62, W, 50);
        drawBig([[DEV_TEAM, GOLD]], W / 2, 66, k);
        drawText(ctx, fonts.font, [["WINS THE CHAMPIONSHIP!", WHITE]], W / 2, 96);
      }
    },
    // The battle's bottom screen: both teams, the timer and the leaders on their pedestals.
    drawBottom() {
      const vs = story.vs.anchors;
      ctx.drawImage(img.vs, 0, 0);
      drawText(ctx, fonts.font, [["Championship Final", WHITE]], vs.loc_title[0], vs.loc_title[1] - 7);
      drawText(ctx, fonts.font_small, [[DEV_TEAM, GOLD]], vs.team_name0[0], vs.team_name0[1] - 1, "left");
      drawText(ctx, fonts.font_small, [[RIVAL_TEAM, WHITE]], vs.team_name1[0], vs.team_name1[1] - 1, "left");
      const digits = String(scene.timer).padStart(3, "0");
      const d = story.digits;
      [vs.time_digit0, vs.time_digit1, vs.time_digit2].forEach(([x, y], i) => {
        ctx.drawImage(img.digits, Number(digits[i]) * d.width, 0, d.width, d.height,
          Math.round(x - d.width / 2), Math.round(y - d.height / 2), d.width, d.height);
      });
      drawActor(scene.dev[0], { x: 50, y: 166 });
      drawActor(scene.rivals[0], { x: 206, y: 166 });
    },
  },

  // The player's DigiEgg, shaking in the light: the starter wheel comes next.
  egg: {
    drawTop(t) {
      ctx.drawImage(img.bg_top, 0, 0);
      rays(W / 2, 112, t, "rgba(255, 240, 170, 0.10)");
      const egg = manifest.egg;
      const durations = egg.durations;
      let left = (t * 1.5) % (durations.reduce((s, x) => s + x, 0) * FRAME_MS), frame = 0;
      for (; frame < durations.length - 1 && (left -= durations[frame] * FRAME_MS) >= 0; frame++);
      const s = 4;
      ctx.fillStyle = "rgba(0, 16, 48, 0.4)";
      ctx.beginPath();
      ctx.ellipse(W / 2, 146, 22, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.drawImage(img.egg, frame * egg.width, 0, egg.width, egg.height,
        Math.round(W / 2 - (egg.width * s) / 2), 146 - egg.height * s, egg.width * s, egg.height * s);
      drawText(ctx, fonts.font, [["Your partner is about to hatch!", WHITE]], W / 2, 162);
    },
  },
};

// --- story flow ----------------------------------------------------------------------

function goTo(next) {
  if (next >= STORY.length) return finish();
  const changes = !scene || STORY[next].scene !== scene.name;
  if (changes && step >= 0) {
    fade = { t: 0, next, switched: false };
    return;
  }
  setStep(next);
}

function setStep(next) {
  step = next;
  stepT = 0;
  typed = 0;
  const page = STORY[step];
  if (!scene || page.scene !== scene.name) newScene(page.scene);
  if (page.reveal) scene.revealAt = scene.t;
  lines = page.text ? wrap(page.text) : [];
  chars = lines.reduce((n, runs) => n + runs.reduce((m, [t]) => m + t.length, 0), 0);
}

const pageTyped = () => typed >= chars;
const readMs = () => READ_MS + chars * READ_PER_CHAR_MS;

// A click or a key: show the whole page at once, or go on to the next one.
function advance() {
  if (finished || fade || step < 0) return;
  const page = STORY[step];
  if (!page.text) return;                      // the final plays to its end
  if (!pageTyped()) typed = chars;
  else goTo(step + 1);
}

async function finish() {
  if (finished) return;
  finished = true;
  fade = { t: 0, next: STORY.length, switched: false };
  try {
    await fetch("/api/story/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (err) {
    console.error(err);
  }
  setTimeout(() => { location.href = "/starter"; }, FADE_MS);
}

function update(dt) {
  if (fade) {
    fade.t += dt;
    if (!fade.switched && fade.t >= FADE_MS && fade.next < STORY.length) {
      fade.switched = true;
      setStep(fade.next);
    }
    if (fade.t >= 2 * FADE_MS && fade.next < STORY.length) fade = null;
  }
  if (step < 0) return;
  stepT += dt;
  const page = STORY[step];
  if (page.text) {
    typed = Math.min(chars, typed + dt / TYPE_MS);
    if (pageTyped() && !fade && stepT > chars * TYPE_MS + readMs()) goTo(step + 1);
  } else if (scene.t >= SCENES[scene.name].length && !fade) {
    goTo(step + 1);
  }

  scene.t += dt;
  for (const timer of scene.timers.filter((x) => x.at <= scene.t)) {
    scene.timers.splice(scene.timers.indexOf(timer), 1);
    timer.fn();
  }
  for (const a of scene.actors) {
    a.moveT += dt;
    a.flashT += dt;
    if (a.tween) {
      const tw = a.tween;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.ms);
      a.x = tw.x0 + (tw.x - tw.x0) * k;
      a.y = tw.y0 + (tw.y - tw.y0) * k;
      if (k >= 1) a.tween = null;
    }
  }
  for (const s of scene.shots) {
    s.t += dt;
    if (s.t >= s.ms && !s.done) {
      s.done = true;
      s.hit();
    }
  }
  scene.shots = scene.shots.filter((s) => !s.done);
  for (const p of scene.pops) p.t += dt;
  scene.pops = scene.pops.filter((p) => p.t < 900);
  scene.shake = Math.max(0, scene.shake - dt / 60);
  SCENES[scene.name].update?.(dt);
}

// --- drawing ---------------------------------------------------------------------

function drawTop() {
  const def = SCENES[scene.name];
  ctx.save();
  if (scene.shake) ctx.translate(Math.round((Math.random() - 0.5) * scene.shake * 2), Math.round((Math.random() - 0.5) * scene.shake * 2));
  def.drawTop(scene.t);
  for (const a of [...scene.actors].sort((p, q) => p.y - q.y)) drawActor(a);
  if (scene.name === "battle") for (const a of scene.actors) if (a.hp > 0 || a.alpha === 1) drawHpBar(a);
  for (const s of scene.shots) drawShot(s);
  for (const p of scene.pops) {
    if (!Number(p.text)) continue;
    ctx.globalAlpha = Math.min(1, (900 - p.t) / 300);
    drawText(ctx, fonts.font, [[p.text, RED]], p.x, Math.round(p.y - Math.min(12, p.t / 30)));
    ctx.globalAlpha = 1;
  }
  def.drawOver?.(scene.t);
  ctx.restore();
}

// The bottom screen: the game's message window over the menus' hexagons, typing the page.
function drawBottom(t) {
  const def = SCENES[scene.name];
  if (!STORY[step].text && def.drawBottom) return def.drawBottom();
  ctx.drawImage(img.bg_bottom, 0, 0);
  const win = manifest.window;
  ctx.drawImage(img.window, win.x, win.y);
  const [mx, my] = win.anchors.message;
  let left = Math.floor(typed);
  const top = my - 7 - (lines.length - 1) * 7.5;
  lines.forEach((runs, k) => {
    const width = runs.reduce((w, [text]) => w + textWidth(fonts.font, text), 0);
    const shown = firstLetters(runs, left);
    left -= runs.reduce((n, [text]) => n + text.length, 0);
    drawText(ctx, fonts.font, shown, Math.round(mx - width / 2), Math.round(top + k * 15), "left");
  });
  if (pageTyped() && Math.floor(t / 400) % 2 === 0) drawText(ctx, fonts.font, [["▼", GOLD]], 222, 98);
  // Where the story stands: one dot per page.
  STORY.forEach((page, i) => {
    ctx.fillStyle = i === step ? "#ffd620" : i < step ? "#3fd2ff" : "rgba(255, 255, 255, 0.3)";
    ctx.fillRect(W / 2 - STORY.length * 4 + i * 8, 176, 4, 4);
  });
}

function fadeAlpha() {
  if (!fade) return 0;
  return fade.t < FADE_MS ? fade.t / FADE_MS : Math.max(0, 1 - (fade.t - FADE_MS) / FADE_MS);
}

function draw(t) {
  ctx.setTransform(PX, 0, 0, PX, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H * 2);
  if (scene) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    drawTop();
    ctx.restore();
    ctx.save();
    ctx.translate(0, H);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    drawBottom(t);
    ctx.restore();
  }
  const a = finished && fade?.t >= FADE_MS ? 1 : fadeAlpha();
  if (a) {
    ctx.fillStyle = `rgba(0, 0, 0, ${a})`;
    ctx.fillRect(0, 0, W, H * 2);
  }
}

let last = performance.now();
function tick(now) {
  update(Math.min(50, now - last));
  last = now;
  draw(now);
  requestAnimationFrame(tick);
}

// --- input and page --------------------------------------------------------------

canvas.addEventListener("click", advance);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    advance();
  } else if (e.key === "Escape") {
    finish();
  }
});
document.getElementById("skip").addEventListener("click", finish);

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
  const [res, storyRes] = await Promise.all([fetch(`${ASSETS}manifest.json`), fetch(`${ASSETS}story/story.json`)]);
  if (res.status === 401) {
    location.href = "/";
    return;
  }
  if (!res.ok || !storyRes.ok) {
    errorEl.textContent = "Game graphics missing: run tools/export_story_assets.py.";
    return;
  }
  manifest = await res.json();
  story = await storyRes.json();
  const files = {
    bg_top: manifest.bg_top, bg_bottom: manifest.bg_bottom, window: manifest.window.image, egg: manifest.egg.sprite,
    arena: "intro/arena.png", logo: "intro/logo.png", vs: "story/" + story.vs.image, digits: "story/" + story.digits.image,
    ...Object.fromEntries(Object.entries(story.fields).map(([key, file]) => [key, "story/" + file])),
  };
  await Promise.all(Object.entries(files).map(async ([key, file]) => { img[key] = await loadImage(file); }));
  img.logoShine = document.createElement("canvas");
  img.logoShine.width = img.logo.width;
  img.logoShine.height = img.logo.height;
  await Promise.all(Object.entries(story.fighters).map(async ([sprite, entry]) => {
    const image = await loadImage("story/" + entry.image);
    fighters[sprite] = { ...entry, img: image, white: whiteSheet(image) };
  }));
  for (const key of ["font", "font_small"]) {
    const m = await (await fetch(ASSETS + manifest[key].metrics)).json();
    fonts[key] = { m, image: await loadImage(manifest[key].image), tints: {} };
  }
  goTo(0);
  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error(err);
  errorEl.textContent = "The intro could not start: skip it to choose your partner.";
});
