(() => {
  "use strict";

  // ---------- Canvas & layout ----------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  let viewW = 0, viewH = 0;
  let roadLeft = 0, roadRight = 0, roadWidth = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = viewW + "px";
    canvas.style.height = viewH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    roadWidth = Math.min(viewW * 0.82, 480);
    roadLeft = (viewW - roadWidth) / 2;
    roadRight = roadLeft + roadWidth;

    player.y = viewH * 0.76;
    if (player.x === 0) player.x = (roadLeft + roadRight) / 2;
    player.x = clamp(player.x, roadLeft + player.w / 2 + 4, roadRight - player.w / 2 - 4);

    buildSideTiles();
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ---------- Seeded RNG for stable building rooftops ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let leftTile = null, rightTile = null;
  const TILE_H = 220;

  function buildSideTile(seed) {
    const rng = mulberry32(seed);
    const margin = Math.max(roadLeft, 70);
    const w = Math.ceil(margin) + 2;
    const tile = document.createElement("canvas");
    tile.width = w;
    tile.height = TILE_H;
    const tctx = tile.getContext("2d");

    // base ground / alley colour
    tctx.fillStyle = "#0a0d14";
    tctx.fillRect(0, 0, w, TILE_H);

    const palette = ["#1c2230", "#222a3b", "#192030", "#252d40"];
    let y = 0;
    while (y < TILE_H) {
      const blockH = rand(60, 130);
      const inset = rand(2, 10);
      const blockW = w - inset;
      tctx.fillStyle = pick(palette);
      tctx.fillRect(0, y, blockW, Math.min(blockH, TILE_H - y));
      // roof edge highlight
      tctx.fillStyle = "rgba(255,255,255,0.05)";
      tctx.fillRect(0, y, blockW, 2);
      // scattered terrace lights
      const lights = Math.floor(rng() * 4);
      for (let i = 0; i < lights; i++) {
        const lx = rng() * (blockW - 10) + 4;
        const ly = y + rng() * (Math.min(blockH, TILE_H - y) - 10) + 4;
        tctx.fillStyle = rng() > 0.5 ? "rgba(255,196,90,0.85)" : "rgba(140,190,255,0.5)";
        tctx.fillRect(lx, ly, 3, 3);
      }
      // occasional water tank
      if (rng() > 0.55 && blockW > 30) {
        const tx = rng() * (blockW - 20) + 10;
        const ty = y + rand(10, Math.max(12, Math.min(blockH, TILE_H - y) - 10));
        tctx.fillStyle = "#0d1118";
        tctx.beginPath();
        tctx.arc(tx, ty, 6, 0, Math.PI * 2);
        tctx.fill();
        tctx.strokeStyle = "rgba(255,255,255,0.08)";
        tctx.stroke();
      }
      y += blockH + rand(4, 14);
    }
    return tile;
  }

  function buildSideTiles() {
    leftTile = buildSideTile(7);
    rightTile = buildSideTile(99);
  }

  // ---------- Game constants ----------
  const ACCEL = 1500;
  const MAX_VX = 460;
  const DAMPING = 7;
  const BASE_SPEED = 230;
  const MAX_SPEED = 540;
  const TOTAL_DISTANCE = 7600;
  const SEGMENTS = 3;

  // ---------- Entities ----------
  const player = {
    x: 0, y: 0, w: 40, h: 60, vx: 0, tilt: 0,
  };

  let obstacles = [];
  let distance = 0;
  let speed = BASE_SPEED;
  let spawnTimer = 0;
  let roadDashOffset = 0;
  let buildingOffset = 0;
  let elapsed = 0;
  let state = "start"; // start | playing | gameover | win

  const OBSTACLE_TYPES = {
    auto: { w: 42, h: 60, body: "#caa400", roof: "#16161a", kind: "auto" },
    car: { w: 46, h: 70, body: "#0e1016", roof: "#1c1f29", kind: "car" },
    truck: { w: 58, h: 92, body: "#8a4a1f", roof: "#5c3115", kind: "truck" },
    cone: { w: 24, h: 26, body: "#ff7a18", roof: null, kind: "cone" },
  };

  function resetGame() {
    obstacles = [];
    distance = 0;
    speed = BASE_SPEED;
    spawnTimer = 0.6;
    roadDashOffset = 0;
    buildingOffset = 0;
    elapsed = 0;
    player.x = (roadLeft + roadRight) / 2;
    player.vx = 0;
    player.tilt = 0;
    leftHeld = false;
    rightHeld = false;
  }

  // ---------- Input ----------
  let leftHeld = false, rightHeld = false;
  const touchSources = new Map(); // pointerId -> 'left' | 'right'

  function setZoneFromX(x) {
    return x < viewW / 2 ? "left" : "right";
  }

  function pointerDown(e) {
    if (state !== "playing") return;
    const zone = setZoneFromX(e.clientX);
    touchSources.set(e.pointerId, zone);
    if (zone === "left") leftHeld = true; else rightHeld = true;
  }
  function pointerUp(e) {
    touchSources.delete(e.pointerId);
    recomputeHeld();
  }
  function recomputeHeld() {
    leftHeld = false; rightHeld = false;
    for (const zone of touchSources.values()) {
      if (zone === "left") leftHeld = true;
      if (zone === "right") rightHeld = true;
    }
  }

  function tryCapture(el, pointerId) {
    try { el.setPointerCapture?.(pointerId); } catch { /* pointer already released */ }
  }

  canvas.addEventListener("pointerdown", (e) => { tryCapture(canvas, e.pointerId); pointerDown(e); });
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  const leftBtn = document.getElementById("left-btn");
  const rightBtn = document.getElementById("right-btn");
  function bindBtn(el, zone) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      tryCapture(el, e.pointerId);
      touchSources.set(e.pointerId, zone);
      recomputeHeld();
    });
    el.addEventListener("pointerup", (e) => { touchSources.delete(e.pointerId); recomputeHeld(); });
    el.addEventListener("pointercancel", (e) => { touchSources.delete(e.pointerId); recomputeHeld(); });
  }
  bindBtn(leftBtn, "left");
  bindBtn(rightBtn, "right");

  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a") leftHeld = true;
    if (e.key === "ArrowRight" || e.key === "d") rightHeld = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a") leftHeld = false;
    if (e.key === "ArrowRight" || e.key === "d") rightHeld = false;
  });

  // ---------- Spawning ----------
  function spawnWave(progress) {
    const segW = roadWidth / SEGMENTS;
    const emptySeg = Math.floor(rand(0, SEGMENTS));
    const fillChance = lerp(0.55, 0.95, progress);
    for (let i = 0; i < SEGMENTS; i++) {
      if (i === emptySeg) continue;
      if (Math.random() > fillChance) continue;
      const typeKey = progress > 0.3 ? pick(["auto", "car", "truck", "cone"]) : pick(["auto", "car", "cone"]);
      const t = OBSTACLE_TYPES[typeKey];
      const segCenter = roadLeft + segW * i + segW / 2;
      const x = clamp(segCenter + rand(-segW * 0.15, segW * 0.15), roadLeft + t.w / 2 + 2, roadRight - t.w / 2 - 2);
      obstacles.push({ x, y: -t.h, w: t.w, h: t.h, type: t, passed: false });
    }
  }

  // ---------- Update ----------
  function update(dt) {
    if (state !== "playing") return;
    elapsed += dt;

    const progress = clamp(distance / TOTAL_DISTANCE, 0, 1);
    speed = lerp(BASE_SPEED, MAX_SPEED, progress);

    // steering
    if (leftHeld) player.vx -= ACCEL * dt;
    if (rightHeld) player.vx += ACCEL * dt;
    if (!leftHeld && !rightHeld) player.vx -= player.vx * DAMPING * dt;
    player.vx = clamp(player.vx, -MAX_VX, MAX_VX);
    player.x += player.vx * dt;

    const minX = roadLeft + player.w / 2 + 2;
    const maxX = roadRight - player.w / 2 - 2;
    if (player.x < minX) { player.x = minX; player.vx = 0; }
    if (player.x > maxX) { player.x = maxX; player.vx = 0; }
    player.tilt = clamp(player.vx / MAX_VX, -1, 1) * 0.22;

    // distance & scenery scroll
    distance += speed * dt;
    roadDashOffset = (roadDashOffset + speed * dt) % 80;
    buildingOffset = (buildingOffset + speed * dt * 0.85) % TILE_H;

    // spawn
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnWave(progress);
      spawnTimer = lerp(1.05, 0.5, progress) * rand(0.85, 1.15);
    }

    // move obstacles & collide
    const pad = 0.16;
    for (const o of obstacles) {
      o.y += speed * dt;
      const dx = Math.abs(o.x - player.x);
      const dy = Math.abs(o.y - player.y);
      const hitW = (o.w + player.w) / 2 * (1 - pad);
      const hitH = (o.h + player.h) / 2 * (1 - pad);
      if (dx < hitW && dy < hitH) {
        crash();
        return;
      }
    }
    obstacles = obstacles.filter((o) => o.y - o.h / 2 < viewH + 40);

    updateHud(progress);

    if (distance >= TOTAL_DISTANCE) {
      win();
    }
  }

  // ---------- HUD ----------
  const fillEl = document.getElementById("progress-fill");
  const markerEl = document.getElementById("progress-marker");
  function updateHud(progress) {
    const pct = (progress * 100).toFixed(0);
    fillEl.style.width = pct + "%";
    markerEl.style.left = pct + "%";
  }

  // ---------- Drawing ----------
  function drawVehicle(o) {
    const { x, y, w, h } = o;
    const t = o.type;
    ctx.save();
    ctx.translate(x, y);

    if (t.kind === "cone") {
      ctx.fillStyle = "#ff7a18";
      ctx.beginPath();
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(-w / 2 + 3, 0, w - 6, 4);
      ctx.restore();
      return;
    }

    roundRect(-w / 2, -h / 2, w, h, 8);
    ctx.fillStyle = t.body;
    ctx.fill();

    if (t.roof) {
      roundRect(-w / 2 + 5, -h / 2 + 10, w - 10, h - 26, 6);
      ctx.fillStyle = t.roof;
      ctx.fill();
    }

    // headlight glow (forward = up)
    ctx.fillStyle = "rgba(255,250,210,0.95)";
    ctx.shadowColor = "rgba(255,235,150,0.9)";
    ctx.shadowBlur = 8;
    ctx.fillRect(-w / 2 + 4, -h / 2 + 2, 6, 4);
    ctx.fillRect(w / 2 - 10, -h / 2 + 2, 6, 4);
    ctx.shadowBlur = 0;

    // taillight (rear = down, toward viewer)
    ctx.fillStyle = "rgba(255,60,60,0.9)";
    ctx.fillRect(-w / 2 + 4, h / 2 - 6, 5, 4);
    ctx.fillRect(w / 2 - 9, h / 2 - 6, 5, 4);

    ctx.restore();
  }

  function drawPlayer() {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.tilt);

    const w = player.w, h = player.h;
    roundRect(-w / 2, -h / 2, w, h, 9);
    ctx.fillStyle = "#ffce1f";
    ctx.fill();

    roundRect(-w / 2 + 5, -h / 2 + 12, w - 10, h - 28, 6);
    ctx.fillStyle = "#15151a";
    ctx.fill();

    // accent stripe so player reads as distinct from traffic
    ctx.fillStyle = "#1f7bd6";
    ctx.fillRect(-3, -h / 2 + 4, 6, h - 8);

    // headlight glow
    ctx.fillStyle = "rgba(255,255,235,1)";
    ctx.shadowColor = "rgba(255,245,180,1)";
    ctx.shadowBlur = 10;
    ctx.fillRect(-w / 2 + 4, -h / 2 + 1, 7, 4);
    ctx.fillRect(w / 2 - 11, -h / 2 + 1, 7, 4);
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(255,60,60,0.9)";
    ctx.fillRect(-w / 2 + 4, h / 2 - 6, 5, 4);
    ctx.fillRect(w / 2 - 9, h / 2 - 6, 5, 4);

    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render() {
    ctx.clearRect(0, 0, viewW, viewH);

    // sky/ground backdrop
    const grad = ctx.createLinearGradient(0, 0, 0, viewH);
    grad.addColorStop(0, "#070a12");
    grad.addColorStop(1, "#0c1018");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, viewW, viewH);

    // rooftops either side, tiled & scrolling
    if (leftTile) {
      const off = buildingOffset % TILE_H;
      for (let y = -TILE_H + off; y < viewH; y += TILE_H) {
        ctx.drawImage(leftTile, 0, y);
        ctx.drawImage(rightTile, viewW - rightTile.width, y);
      }
    }

    // road surface
    ctx.fillStyle = "#1a1d24";
    ctx.fillRect(roadLeft, 0, roadWidth, viewH);

    // curbs
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(roadLeft - 4, 0, 4, viewH);
    ctx.fillRect(roadRight, 0, 4, viewH);

    // lane dashes
    const segW = roadWidth / SEGMENTS;
    ctx.fillStyle = "rgba(255,210,90,0.55)";
    for (let i = 1; i < SEGMENTS; i++) {
      const x = roadLeft + segW * i;
      for (let y = -80 + roadDashOffset; y < viewH; y += 80) {
        ctx.fillRect(x - 2, y, 4, 36);
      }
    }

    for (const o of obstacles) drawVehicle(o);
    if (state === "playing" || state === "gameover") drawPlayer();
  }

  // ---------- Loop ----------
  let lastTime = 0;
  function loop(ts) {
    if (!lastTime) lastTime = ts;
    let dt = (ts - lastTime) / 1000;
    lastTime = ts;
    dt = Math.min(dt, 1 / 30);

    update(dt);
    render();

    requestAnimationFrame(loop);
  }

  // ---------- Game state transitions ----------
  const startScreen = document.getElementById("start-screen");
  const gameoverScreen = document.getElementById("gameover-screen");
  const winScreen = document.getElementById("win-screen");
  const bestStatEl = document.getElementById("best-stat");

  function crash() {
    state = "gameover";
    const pct = Math.floor((distance / TOTAL_DISTANCE) * 100);
    document.getElementById("gameover-progress").textContent = pct;
    const best = Number(localStorage.getItem("rr_best_pct") || 0);
    if (pct > best) localStorage.setItem("rr_best_pct", String(pct));
    gameoverScreen.classList.remove("hidden");
  }

  function win() {
    state = "win";
    const t = elapsed.toFixed(1);
    document.getElementById("win-time").textContent = t;
    const bestTime = Number(localStorage.getItem("rr_best_time") || Infinity);
    if (elapsed < bestTime) localStorage.setItem("rr_best_time", String(elapsed));
    winScreen.classList.remove("hidden");
  }

  function showBestStat() {
    const pct = Number(localStorage.getItem("rr_best_pct") || 0);
    const bestTime = Number(localStorage.getItem("rr_best_time") || 0);
    if (bestTime > 0) {
      bestStatEl.textContent = `Best run: reached the Trident in ${bestTime.toFixed(1)}s`;
    } else if (pct > 0) {
      bestStatEl.textContent = `Best run: ${pct}% of the way home`;
    } else {
      bestStatEl.textContent = "";
    }
  }

  function startGame() {
    resetGame();
    state = "playing";
    startScreen.classList.add("hidden");
    gameoverScreen.classList.add("hidden");
    winScreen.classList.add("hidden");
  }

  document.getElementById("start-btn").addEventListener("click", startGame);
  document.getElementById("retry-btn").addEventListener("click", startGame);
  document.getElementById("again-btn").addEventListener("click", startGame);

  // ---------- Boot ----------
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  resize();
  showBestStat();
  requestAnimationFrame(loop);
})();
