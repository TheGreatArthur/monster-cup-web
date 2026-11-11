// The intro page's background: a battle as the game plays it. Two teams of Rookies roam one of
// the game's battle grounds seen from above: they run at an opponent, strike up close or fire a
// shot in the colour of their signature attack, flash white and stagger when hit, get knocked off
// their feet now and then, lie down a moment and get back up. Nobody wins: there are no HP bars,
// the brawl goes on and the camera follows it. Every half minute the scene changes ground and
// teams. The sprites, their moves and the grounds are the game's own, exported by
// tools/export_site_assets.py; the shots, sparks and dust are drawn here. The scene is drawn in DS
// pixels on a small canvas that CSS scales up.
const ASSETS = "/game-assets/intro/";
const FRAME_MS = 1000 / 60;        // the game's animation durations are in 1/60 s
const LOOPING = new Set(["idle", "run", "win"]);
const MELEE = ["atk1", "atk3"], RANGED = ["atk2", "atk4"];
const RUN_SPEED = 52;              // DS pixels per second
const SCENE_MS = 30_000, FADE_MS = 700;

const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");
const tint = document.createElement("canvas");   // a sprite frame turned white, for hits
const tintCtx = tint.getContext("2d");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const lerp = (a, b, p) => a + (b - a) * p;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let manifest, sheets, grounds;
let scale = 2, W = 0, H = 0;
let ground, zone;                  // the scene's ground image and where the fighters may go
let fighters = [];
const effects = [];                // sparks, shots, dust: { update(dt), draw(), dead }
let cam = { x: 0, y: 0 };
let shake = 0;
let sceneIndex = 0, sceneT = 0, fade = 1;

// --- layout -------------------------------------------------------------------------------

// The canvas covers the window with one ground (384x288): its scale is the smallest whole one
// that leaves no gap, so the camera has a little room to follow the fight.
function resize() {
  const gw = ground?.width ?? 384, gh = ground?.height ?? 288;
  scale = Math.max(2, Math.ceil(Math.max(innerWidth / gw, innerHeight / gh)));
  W = Math.ceil(innerWidth / scale);
  H = Math.ceil(innerHeight / scale);
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  ctx.imageSmoothingEnabled = false;
  if (ground) zone = fightZone();
}

// The part of the ground the teams fight on: around its middle, a bit wider than the view.
// On a phone the logo and the login card fill the top: the fight keeps to the bottom half.
function fightZone() {
  const w = Math.min(ground.width - 40, Math.max(W - 16, 150));
  const x0 = (ground.width - w) / 2;
  if (H > W * 1.4) {
    const y1 = Math.min(ground.height, (ground.height + H) / 2) - 14;
    return { x0, x1: x0 + w, y0: y1 - H * 0.4, y1 };
  }
  const h = Math.min(ground.height - 60, Math.max(H - 50, 120));
  const y0 = (ground.height - h) / 2 + 10;
  return { x0, x1: x0 + w, y0, y1: y0 + h };
}

// --- the fighters ---------------------------------------------------------------------------

function fighter(sprite, team, x, y) {
  const data = manifest.fighters[sprite];
  return { sprite, data, sheet: sheets[sprite], team, x, y, z: 0, vx: 0, vz: 0, face: team === 0 ? 1 : -1,
    move: "idle", moveT: rand(0, 600), state: "rest", stateT: 0, wait: rand(400, 1400), target: null,
    attack: null, struck: false, flashT: 0, hits: 0, knockAt: Math.floor(rand(3, 6)) };
}

const totalMs = (f, move) => f.data.moves[move].durations.reduce((a, b) => a + b, 0) * FRAME_MS;
// The strike lands on a move's last frame: after every frame but the last.
const strikeMs = (f, move) => f.data.moves[move].durations.slice(0, -1).reduce((a, b) => a + b, 0) * FRAME_MS;

function setMove(f, move) {
  if (f.move === move) return;
  f.move = move;
  f.moveT = 0;
}

function setState(f, state, wait = 0) {
  f.state = state;
  f.stateT = 0;
  f.wait = wait;
}

function frameIndex(f) {
  const durations = f.data.moves[f.move].durations;
  let t = f.moveT / FRAME_MS;
  if (LOOPING.has(f.move)) t %= durations.reduce((a, b) => a + b, 0);
  let i = 0;
  while (i < durations.length - 1 && t >= durations[i]) t -= durations[i++];
  return i;
}

const standing = (f) => f.state !== "knock" && f.state !== "down";
const height = (f) => f.data.anchor[1];

function chooseTarget(f) {
  const foes = fighters.filter((o) => o.team !== f.team && standing(o));
  if (!foes.length) return null;
  // Mostly the nearest opponent, sometimes anyone: the fight moves around.
  foes.sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y) - Math.hypot(b.x - f.x, b.y - f.y));
  return Math.random() < 0.7 ? foes[0] : pick(foes);
}

// Where to stand to attack: right next to the target for a strike, at a distance for a shot.
function attackSpot(f) {
  const t = f.target;
  const side = Math.sign(f.x - t.x) || (f.team === 0 ? -1 : 1);
  const melee = MELEE.includes(f.attack);
  const dx = melee ? 12 + t.data.width * 0.15 : f.range;
  return {
    x: clamp(t.x + side * dx, zone.x0, zone.x1),
    y: clamp(t.y + (melee ? 0 : f.offset), zone.y0, zone.y1),
  };
}

function update(dt) {
  sceneT += dt;
  if (sceneT > SCENE_MS) fade = Math.max(0, fade - dt / FADE_MS);
  else fade = Math.min(1, fade + dt / FADE_MS);
  if (sceneT > SCENE_MS && fade === 0) newScene();

  for (const f of fighters) {
    f.moveT += dt;
    f.stateT += dt;
    f.flashT -= dt;
    think(f, dt);
  }
  // Nobody stands inside anybody else.
  for (const a of fighters) {
    for (const b of fighters) {
      if (a === b || !standing(a) || !standing(b)) continue;
      const dx = a.x - b.x, dy = (a.y - b.y) * 2;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < 12) {
        a.x += (dx / d) * (12 - d) * 0.1;
        a.y += (dy / d) * (12 - d) * 0.05;
      }
    }
  }
  for (const e of effects) e.update(dt);
  for (let i = effects.length - 1; i >= 0; i--) if (effects[i].dead) effects.splice(i, 1);
  shake = Math.max(0, shake - dt / 60);

  // The camera follows the middle of the fight, slowly.
  const mx = fighters.reduce((s, f) => s + f.x, 0) / fighters.length;
  const my = fighters.reduce((s, f) => s + f.y, 0) / fighters.length - 10;
  const k = Math.min(1, dt / 900);
  cam.x = lerp(cam.x, clamp(mx, W / 2, ground.width - W / 2), k);
  cam.y = lerp(cam.y, clamp(my, H / 2, ground.height - H / 2), k);
}

function think(f, dt) {
  const s = dt / 1000;
  switch (f.state) {
    case "rest":
      setMove(f, "idle");
      if (f.stateT > f.wait) setState(f, "roam");
      break;

    case "roam": {
      if (!f.target || !standing(f.target) || f.stateT === dt && Math.random() < 0.3) {
        f.target = chooseTarget(f);
        f.attack = pick(Math.random() < 0.6 ? MELEE : RANGED);
        f.range = rand(60, 95);
        f.offset = rand(-14, 14);
      }
      if (!f.target) {
        setState(f, "rest", rand(600, 1200));
        break;
      }
      const spot = attackSpot(f);
      const dx = spot.x - f.x, dy = spot.y - f.y, d = Math.hypot(dx, dy);
      // Close enough, or chasing for too long: attack from here, a shot if out of reach.
      if (d < 3 || f.stateT > 3500) {
        if (d >= 3 && Math.abs(f.target.x - f.x) > 30) f.attack = pick(RANGED);
        startAttack(f);
        break;
      }
      setMove(f, "run");
      const step = Math.min(d, RUN_SPEED * s);
      f.x += (dx / d) * step;
      f.y += (dy / d) * step;
      if (Math.abs(dx) > 1) f.face = Math.sign(dx);
      if (Math.random() < dt / 260) effects.push(dust(f.x - f.face * 4, f.y, 1));
      break;
    }

    case "attack": {
      const at = strikeMs(f, f.attack);
      // A strike lunges forward as it lands.
      if (MELEE.includes(f.attack) && f.stateT > at - 90 && f.stateT < at + 60) f.x += f.face * 70 * s;
      if (!f.struck && f.stateT >= at) {
        f.struck = true;
        strike(f);
      }
      if (f.stateT > totalMs(f, f.attack) + 160) setState(f, "rest", rand(250, 900));
      break;
    }

    case "hit":
      f.x = clamp(f.x + f.vx * s, zone.x0 - 10, zone.x1 + 10);
      f.vx *= Math.pow(0.02, s);
      if (f.stateT > 380) setState(f, "rest", rand(100, 400));
      break;

    case "knock":
      f.x = clamp(f.x + f.vx * s, zone.x0 - 16, zone.x1 + 16);
      f.vz -= 330 * s;
      f.z += f.vz * s;
      if (f.z <= 0) {
        f.z = 0;
        effects.push(dust(f.x, f.y, 6));
        shake = Math.max(shake, 2);
        setMove(f, "ko");
        setState(f, "down", rand(1200, 2000));
      }
      break;

    case "down":
      if (f.stateT > f.wait) {
        f.vz = 70;
        setState(f, "rise");
        setMove(f, "idle");
      }
      break;

    case "rise":
      // Springs back up with a little hop.
      f.vz -= 330 * s;
      f.z = Math.max(0, f.z + f.vz * s);
      if (f.z === 0 && f.stateT > 120) setState(f, "rest", rand(300, 700));
      break;

    case "cheer":
      setMove(f, "win");
      if (f.stateT > f.wait) setState(f, "rest", 200);
      break;
  }
  f.y = clamp(f.y, zone.y0 - 6, zone.y1 + 6);
}

function startAttack(f) {
  f.face = Math.sign(f.target.x - f.x) || f.face;
  f.struck = false;
  setMove(f, f.attack);
  setState(f, "attack");
}

function strike(f) {
  const t = f.target;
  if (!t) return;
  if (MELEE.includes(f.attack)) {
    const reach = 18 + t.data.width * 0.2;
    if (standing(t) && Math.abs(t.x - f.x) < reach && Math.abs(t.y - f.y) < 10) hit(t, f, 1);
    else effects.push(dust(f.x + f.face * 8, f.y, 3));   // a swing at the air
    return;
  }
  const color = f.data.color;
  const power = f.attack === "atk4" ? 1.4 : 1;
  effects.push(bolt(f.x + f.face * 10, f.y - height(f) * 0.5, t, color, power, () => {
    if (standing(t) && Math.abs(t.y - f.y) < 22) hit(t, f, power, color);
  }));
}

function hit(t, by, power, color = "#ffffff") {
  t.flashT = 110;
  t.face = -by.face;
  const hx = t.x - by.face * 2, hy = t.y - height(t) * 0.55;
  effects.push(spark(hx, hy, color, 10 * power));
  for (let i = 0; i < 6 * power; i++) {
    effects.push(particle(hx, hy, by.face * rand(10, 70), rand(-80, -10), pick(["#ffffff", "#fff3a0", color]), rand(250, 450)));
  }
  t.hits += 1;
  if (t.hits >= t.knockAt || (power > 1.2 && Math.random() < 0.4)) {
    // Knocked off its feet: up, back, and down on the ground.
    t.hits = 0;
    t.knockAt = Math.floor(rand(3, 6));
    t.vx = by.face * rand(55, 80);
    t.vz = rand(85, 110);
    t.z = 0.01;
    setMove(t, "knock");
    setState(t, "knock");
    shake = 3;
    if (Math.random() < 0.6 && by.state === "attack") {
      by.target = null;
      setState(by, "cheer", rand(900, 1500));
    }
    return;
  }
  t.vx = by.face * rand(60, 90) * power;
  setMove(t, "hit");
  setState(t, "hit");
  // It turns on whoever hit it.
  t.target = by;
}

// --- effects -----------------------------------------------------------------------------

function particle(x, y, vx, vy, color, life) {
  return {
    x, y, vx, vy, t: 0,
    update(dt) {
      this.t += dt;
      this.x += (this.vx * dt) / 1000;
      this.y += (this.vy * dt) / 1000;
      this.vy += (220 * dt) / 1000;
      this.dead = this.t > life;
    },
    draw() {
      const s = this.t < life / 2 ? 2 : 1;
      ctx.globalAlpha = 1 - this.t / life;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(this.x), Math.round(this.y), s, s);
    },
  };
}

// The hit spark: a white star, then a ring that fades.
function spark(x, y, color, size) {
  return {
    t: 0,
    update(dt) { this.t += dt; this.dead = this.t > 260; },
    draw() {
      const p = this.t / 260;
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 2 + p * size, 0, Math.PI * 2);
      ctx.stroke();
      if (p < 0.5) {
        const r = Math.round((1 - p / 0.5) * size * 0.7);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(Math.round(x - r), Math.round(y) - 1, r * 2, 2);
        ctx.fillRect(Math.round(x) - 1, Math.round(y - r), 2, r * 2);
      }
    },
  };
}

function dust(x, y, n) {
  const puffs = Array.from({ length: n }, () => ({ x: x + rand(-3, 3), y: y + rand(-1, 1), vx: rand(-14, 14), r: rand(1.5, 3) }));
  return {
    t: 0,
    update(dt) {
      this.t += dt;
      for (const p of puffs) { p.x += (p.vx * dt) / 1000; p.y -= (6 * dt) / 1000; p.r += dt / 400; }
      this.dead = this.t > 420;
    },
    draw() {
      ctx.globalAlpha = 0.5 * (1 - this.t / 420);
      ctx.fillStyle = "#f4ead0";
      for (const p of puffs) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  };
}

// A shot: a glowing ball with a trail flying at the target. It aims where the target was when
// fired, so a target that ran off is missed. Then onHit.
function bolt(x, y, target, color, power, onHit) {
  const tx = target.x, ty = target.y - height(target) * 0.5;
  const dur = clamp(Math.hypot(tx - x, ty - y) * 4.2, 160, 520);
  const trail = [];
  return {
    t: 0,
    update(dt) {
      this.t += dt;
      const p = Math.min(1, this.t / dur);
      this.cx = lerp(x, tx, p);
      this.cy = lerp(y, ty, p) - Math.sin(p * Math.PI) * 6;
      trail.push({ x: this.cx, y: this.cy });
      if (trail.length > 8) trail.shift();
      if (p >= 1) {
        this.dead = true;
        onHit();
      }
    },
    draw() {
      if (this.cx === undefined) return;
      ctx.globalCompositeOperation = "lighter";
      trail.forEach((pt, i) => {
        ctx.globalAlpha = (i / trail.length) * 0.6;
        ctx.fillStyle = color;
        const sz = Math.max(1, Math.round((i / trail.length) * 3 * power));
        ctx.fillRect(Math.round(pt.x - sz / 2), Math.round(pt.y - sz / 2), sz, sz);
      });
      const r = 3 * power + Math.sin(this.t / 40) * 0.5;
      const glow = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, r * 2.4);
      glow.addColorStop(0, "#ffffff");
      glow.addColorStop(0.35, color);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = glow;
      ctx.fillRect(this.cx - r * 2.4, this.cy - r * 2.4, r * 4.8, r * 4.8);
      ctx.globalCompositeOperation = "source-over";
    },
  };
}

// --- scenes -----------------------------------------------------------------------------

// A new ground and two new teams: each famous duo is split, one Rookie on each side.
function newScene() {
  ground = grounds[sceneIndex % grounds.length];
  zone = fightZone();
  const perTeam = W >= 250 ? 3 : 2;
  const duos = manifest.duos;
  const first = (sceneIndex * perTeam) % duos.length;
  const flip = sceneIndex % 2;
  fighters = [];
  for (let i = 0; i < perTeam; i++) {
    const duo = duos[(first + i) % duos.length];
    const y = lerp(zone.y0 + 20, zone.y1 - 10, (i + 0.5) / perTeam) + rand(-6, 6);
    fighters.push(fighter(duo[flip], 0, zone.x0 + rand(10, 40), y));
    fighters.push(fighter(duo[1 - flip], 1, zone.x1 - rand(10, 40), y + rand(-8, 8)));
  }
  effects.length = 0;
  cam = { x: ground.width / 2, y: ground.height / 2 };
  sceneIndex += 1;
  sceneT = 0;
  fade = 0;
}

// --- drawing -----------------------------------------------------------------------------

function drawFighter(f) {
  const { width: w, height: h, anchor, moves } = f.data;
  const sx = frameIndex(f) * w, sy = moves[f.move].row * h;
  const x = Math.round(f.x), y = Math.round(f.y), z = Math.round(f.z);
  // Its shadow stays on the ground while it flies.
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(5, w * 0.18) * (1 - Math.min(0.5, z / 60)), 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(x, y - z);
  if (f.face > 0) ctx.scale(-1, 1);       // the sprites look to the left
  ctx.drawImage(f.sheet, sx, sy, w, h, -anchor[0], -anchor[1], w, h);
  if (f.flashT > 0) {
    // The hit flash: the sprite turns white for a few frames.
    tint.width = w;
    tint.height = h;
    tintCtx.drawImage(f.sheet, sx, sy, w, h, 0, 0, w, h);
    tintCtx.globalCompositeOperation = "source-in";
    tintCtx.fillStyle = "#ffffff";
    tintCtx.fillRect(0, 0, w, h);
    tintCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(tint, -anchor[0], -anchor[1]);
  }
  ctx.restore();
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#04103a";
  ctx.fillRect(0, 0, W, H);
  const ox = Math.round(W / 2 - cam.x + (shake ? rand(-shake, shake) : 0));
  const oy = Math.round(H / 2 - cam.y + (shake ? rand(-shake, shake) : 0));
  ctx.translate(ox, oy);
  ctx.drawImage(ground, 0, 0);
  for (const f of [...fighters].sort((a, b) => a.y - b.y)) drawFighter(f);
  for (const e of effects) e.draw();
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Dimmed in the game's deep blue so the logo and the login card stay readable, darker at the edges.
  ctx.fillStyle = "rgba(4, 16, 58, 0.38)";
  ctx.fillRect(0, 0, W, H);
  const vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  vignette.addColorStop(0, "rgba(4, 16, 58, 0)");
  vignette.addColorStop(1, "rgba(4, 16, 58, 0.75)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
  if (fade < 1) {
    ctx.fillStyle = `rgba(4, 16, 58, ${1 - fade})`;
    ctx.fillRect(0, 0, W, H);
  }
}

async function start() {
  manifest = await (await fetch(ASSETS + "fighters.json")).json();
  const sprites = Object.keys(manifest.fighters);
  const images = await Promise.all([...manifest.grounds, ...sprites.map((s) => manifest.fighters[s].image)]
    .map((f) => loadImage(ASSETS + f)));
  grounds = images.slice(0, manifest.grounds.length);
  sheets = Object.fromEntries(sprites.map((s, i) => [s, images[manifest.grounds.length + i]]));
  sceneIndex = Math.floor(Math.random() * 64);
  ground = grounds[sceneIndex % grounds.length];
  resize();
  newScene();
  addEventListener("resize", resize);

  if (reduceMotion) {
    // A still picture: the teams face to face on the ground.
    fade = 1;
    const still = () => { resize(); draw(); };
    addEventListener("resize", still);
    return still();
  }
  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    update(Math.min(50, now - last));
    last = now;
    draw();
    requestAnimationFrame(frame);
  });
}

start().catch((err) => console.error("arena:", err));
