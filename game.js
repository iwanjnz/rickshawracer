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
  const TILE_H = 240;

  // Building facades (lit windows, balconies) as seen from a high, near-overhead
  // angle, echoing the reference photo's night street rather than a flat rooftop view.
  function buildSideTile(seed, roadEdge) {
    const rng = mulberry32(seed);
    const margin = Math.max(roadLeft, 70);
    const w = Math.ceil(margin) + 2;
    const tile = document.createElement("canvas");
    tile.width = w;
    tile.height = TILE_H;
    const tctx = tile.getContext("2d");

    // alley / sidewalk base
    tctx.fillStyle = "#070911";
    tctx.fillRect(0, 0, w, TILE_H);

    const palette = ["#1b212e", "#202738", "#171c28", "#232b3d", "#1d2433"];
    let y = 0;
    while (y < TILE_H) {
      const blockH = Math.min(rand(80, 160), TILE_H - y);
      const setback = rand(3, 14);
      const blockW = Math.max(20, w - setback);
      const bx = roadEdge === "right" ? 0 : w - blockW;
      tctx.fillStyle = pick(palette);
      tctx.fillRect(bx, y, blockW, blockH);

      // window grid
      const colW = 11, rowH = 16, gap = 3;
      const cols = Math.max(1, Math.floor((blockW - gap) / colW));
      const rows = Math.max(1, Math.floor((blockH - 10) / rowH));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const wx = bx + gap + c * colW;
          const wy = y + 8 + r * rowH;
          if (wy + 9 > y + blockH) continue;
          if (rng() < 0.32) {
            const warm = rng() > 0.3;
            tctx.fillStyle = warm ? "rgba(255,200,110,0.92)" : "rgba(170,212,255,0.55)";
            tctx.shadowColor = warm ? "rgba(255,178,90,0.85)" : "rgba(150,200,255,0.5)";
            tctx.shadowBlur = 3;
            tctx.fillRect(wx, wy, colW - gap, 9);
            tctx.shadowBlur = 0;
          } else {
            tctx.fillStyle = "rgba(0,0,0,0.22)";
            tctx.fillRect(wx, wy, colW - gap, 9);
          }
        }
      }

      // balcony ledges
      for (let r = 3; r < rows; r += 4) {
        tctx.fillStyle = "rgba(0,0,0,0.28)";
        tctx.fillRect(bx, y + 8 + r * rowH - 3, blockW, 2);
      }

      // roofline highlight
      tctx.fillStyle = "rgba(255,255,255,0.07)";
      tctx.fillRect(bx, y, blockW, 2);

      // warm light spill catching the edge nearest the street
      const spillGrad = tctx.createLinearGradient(
        roadEdge === "right" ? bx + blockW : bx, y,
        roadEdge === "right" ? bx + blockW - 16 : bx + 16, y
      );
      spillGrad.addColorStop(0, "rgba(255,160,70,0.16)");
      spillGrad.addColorStop(1, "rgba(255,160,70,0)");
      tctx.fillStyle = spillGrad;
      tctx.fillRect(bx, y, blockW, blockH);

      y += blockH + rand(3, 10);
    }
    return tile;
  }

  function buildSideTiles() {
    leftTile = buildSideTile(7, "right");
    rightTile = buildSideTile(99, "left");
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
  let lampOffset = 0;
  let elapsed = 0;
  let state = "start"; // start | playing | gameover | win
  const LAMP_SPACING = 280;

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
    lampOffset = 0;
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
    lampOffset = (lampOffset + speed * dt) % LAMP_SPACING;

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
  // Headlight beam spilling forward onto the road, like the glowing fronts in the
  // reference photo. Drawn before the body so the body's front edge caps it off.
  function drawHeadlightCone(w, h, len) {
    const nearW = w * 0.55, farW = w * 1.5;
    const grad = ctx.createLinearGradient(0, -h / 2 + 4, 0, -h / 2 - len);
    grad.addColorStop(0, "rgba(255,244,200,0.45)");
    grad.addColorStop(1, "rgba(255,244,200,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-nearW / 2, -h / 2 + 4);
    ctx.lineTo(nearW / 2, -h / 2 + 4);
    ctx.lineTo(farW / 2, -h / 2 - len);
    ctx.lineTo(-farW / 2, -h / 2 - len);
    ctx.closePath();
    ctx.fill();
  }

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

    drawHeadlightCone(w, h, h * 0.9);

    roundRect(-w / 2, -h / 2, w, h, 8);
    ctx.fillStyle = t.body;
    ctx.fill();

    if (t.roof) {
      roundRect(-w / 2 + 5, -h / 2 + 10, w - 10, h - 26, 6);
      ctx.fillStyle = t.roof;
      ctx.fill();
    }

    // headlight units (forward = up)
    ctx.fillStyle = "rgba(255,250,210,0.95)";
    ctx.shadowColor = "rgba(255,235,150,0.9)";
    ctx.shadowBlur = 12;
    ctx.fillRect(-w / 2 + 4, -h / 2 + 2, 6, 4);
    ctx.fillRect(w / 2 - 10, -h / 2 + 2, 6, 4);
    ctx.shadowBlur = 0;

    // taillight glow (rear = down, toward viewer)
    ctx.fillStyle = "rgba(255,70,60,0.55)";
    ctx.shadowColor = "rgba(255,60,50,0.7)";
    ctx.shadowBlur = 6;
    ctx.fillRect(-w / 2 + 3, h / 2 - 7, 7, 5);
    ctx.fillRect(w / 2 - 10, h / 2 - 7, 7, 5);
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  function drawPlayer() {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.tilt);

    const w = player.w, h = player.h;

    drawHeadlightCone(w, h, h * 1.1);

    roundRect(-w / 2, -h / 2, w, h, 9);
    ctx.fillStyle = "#ffce1f";
    ctx.fill();

    roundRect(-w / 2 + 5, -h / 2 + 12, w - 10, h - 28, 6);
    ctx.fillStyle = "#15151a";
    ctx.fill();

    // accent stripe so player reads as distinct from traffic
    ctx.fillStyle = "#1f7bd6";
    ctx.fillRect(-3, -h / 2 + 4, 6, h - 8);

    // headlight units
    ctx.fillStyle = "rgba(255,255,235,1)";
    ctx.shadowColor = "rgba(255,245,180,1)";
    ctx.shadowBlur = 14;
    ctx.fillRect(-w / 2 + 4, -h / 2 + 1, 7, 4);
    ctx.fillRect(w / 2 - 11, -h / 2 + 1, 7, 4);
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(255,70,60,0.6)";
    ctx.shadowColor = "rgba(255,60,50,0.7)";
    ctx.shadowBlur = 6;
    ctx.fillRect(-w / 2 + 3, h / 2 - 7, 7, 5);
    ctx.fillRect(w / 2 - 10, h / 2 - 7, 7, 5);
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  function drawLamp(x, y) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 76);
    glow.addColorStop(0, "rgba(255,196,110,0.28)");
    glow.addColorStop(0.5, "rgba(255,170,90,0.10)");
    glow.addColorStop(1, "rgba(255,170,90,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 76, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,225,170,0.95)";
    ctx.shadowColor = "rgba(255,200,120,0.9)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
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

    // night backdrop
    const grad = ctx.createLinearGradient(0, 0, 0, viewH);
    grad.addColorStop(0, "#050710");
    grad.addColorStop(1, "#0b0f17");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, viewW, viewH);

    // building facades either side, tiled & scrolling (slightly slower for parallax depth)
    if (leftTile) {
      const off = buildingOffset % TILE_H;
      for (let y = -TILE_H + off; y < viewH; y += TILE_H) {
        ctx.drawImage(leftTile, 0, y);
        ctx.drawImage(rightTile, viewW - rightTile.width, y);
      }
    }

    // road surface
    ctx.fillStyle = "#1c1e26";
    ctx.fillRect(roadLeft, 0, roadWidth, viewH);

    // curbs
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(roadLeft - 4, 0, 4, viewH);
    ctx.fillRect(roadRight, 0, 4, viewH);

    // street lamps & their warm glow pools, scrolling with the road
    for (let y = -LAMP_SPACING + lampOffset; y < viewH; y += LAMP_SPACING) {
      drawLamp(roadLeft - 10, y);
      drawLamp(roadRight + 10, y);
    }

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

    // atmospheric haze fading the far distance, like the soft top of the photo
    const haze = ctx.createLinearGradient(0, 0, 0, viewH * 0.4);
    haze.addColorStop(0, "rgba(6,9,16,0.6)");
    haze.addColorStop(1, "rgba(6,9,16,0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, viewW, viewH * 0.4);
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
