import * as THREE from 'three';
import { buildHouse } from './scene.js';
import { Painter } from './painter.js';
import { Network } from './network.js';

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const overlay = $('overlay');
const result = $('result');
const countdownEl = $('countdown');
const playersEl = $('players');
const statusEl = $('status');
const startBtn = $('startBtn');
const restartBtn = $('restartBtn');
const nameInput = $('name');
const timerEl = $('timer');
const scoreboardEl = $('scoreboard');
const rankingEl = $('ranking');
const resultTitleEl = $('resultTitle');
const crosshair = $('crosshair');
const canvas = $('game');

// ----- Three.js core -----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111118);
scene.fog = new THREE.Fog(0x111118, 30, 80);

const camera = new THREE.PerspectiveCamera(55, 2, 0.1, 200);

// Lights
const hemi = new THREE.HemisphereLight(0xffffff, 0x554466, 0.85);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(15, 30, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0005;
scene.add(sun);

// World
const FLOOR_SIZE = 30;
const { group: house, colliders } = buildHouse(FLOOR_SIZE);
scene.add(house);
const painter = new Painter({ floorSize: FLOOR_SIZE, resolution: 1024, gridResolution: 256 });
scene.add(painter.mesh);

// ----- Game state -----
const players = new Map(); // id -> { id, name, color, x, z, ry, mesh, nameSprite }
let myId = null;
let myColor = '#ffffff';
let phase = 'lobby';
let phaseEndsAt = 0;
let currentRanking = null;

// ----- Avatars -----
function colorToInt(hex) { return parseInt(hex.slice(1), 16); }

function createAvatar(player) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: colorToInt(player.color), roughness: 0.4, metalness: 0.1,
    emissive: colorToInt(player.color), emissiveIntensity: 0.15,
  });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.7, 6, 12), bodyMat);
  body.position.y = 0.7;
  body.castShadow = true;
  group.add(body);

  // Head
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe2c2, roughness: 0.7 }),
  );
  head.position.y = 1.45;
  head.castShadow = true;
  group.add(head);

  // Direction indicator (a little nose so we can see facing)
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: colorToInt(player.color) }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.45, 0.22);
  group.add(nose);

  // Tank pack
  const tank = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.14, 0.5, 12),
    new THREE.MeshStandardMaterial({ color: colorToInt(player.color), roughness: 0.3, metalness: 0.7 }),
  );
  tank.position.set(-0.18, 0.95, -0.32);
  tank.rotation.x = 0.2;
  group.add(tank);
  const tank2 = tank.clone(); tank2.position.x = 0.18; group.add(tank2);

  // Name tag
  const nameSprite = makeNameSprite(player.name, player.color);
  nameSprite.position.set(0, 2.05, 0);
  group.add(nameSprite);

  group.position.set(player.x, 0, player.z);
  group.rotation.y = player.ry || 0;
  scene.add(group);

  return { mesh: group, body, nameSprite };
}

function makeNameSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 28px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Background pill
  const text = name;
  const w = ctx.measureText(text).width + 28;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  roundRect(ctx, (256 - w) / 2, 14, w, 36, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.4, 0.6, 1);
  sp.renderOrder = 999;
  return sp;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function refreshNameSprite(player) {
  if (!player.mesh) return;
  player.mesh.remove(player.nameSprite);
  const sp = makeNameSprite(player.name, player.color);
  sp.position.set(0, 2.05, 0);
  player.mesh.add(sp);
  player.nameSprite = sp;
}

function addOrUpdatePlayer(p) {
  let existing = players.get(p.id);
  if (!existing) {
    const view = createAvatar(p);
    existing = { ...p, mesh: view.mesh, body: view.body, nameSprite: view.nameSprite, tx: p.x, tz: p.z, try: p.ry || 0 };
    players.set(p.id, existing);
  } else {
    existing.tx = p.x; existing.tz = p.z; existing.try = p.ry || 0;
    if (p.name && p.name !== existing.name) {
      existing.name = p.name;
      refreshNameSprite(existing);
    }
  }
  updatePlayersUI();
  return existing;
}

function removePlayer(id) {
  const p = players.get(id);
  if (!p) return;
  if (p.mesh) scene.remove(p.mesh);
  players.delete(id);
  updatePlayersUI();
}

function updatePlayersUI() {
  playersEl.innerHTML = '';
  for (const p of players.values()) {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.innerHTML = `<span class="swatch" style="background:${p.color}"></span><span>${p.name}${p.id === myId ? ' (你)' : ''}</span>`;
    playersEl.appendChild(chip);
  }
  startBtn.disabled = players.size < 1;
  if (players.size === 0) statusEl.textContent = '等待玩家加入…';
  else statusEl.textContent = `已连接 ${players.size} 名玩家。任意一人按"开始游戏"即可开始本局。`;
}

// ----- Network -----
const net = new Network();
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
net.connect(wsUrl);

net.on('open', () => {
  statusEl.textContent = '已连接，等待加入…';
});
net.on('close', () => {
  statusEl.textContent = '与服务器断开，请刷新页面';
});
net.on('welcome', (m) => {
  myId = m.id;
  myColor = m.color;
  for (const p of m.players) addOrUpdatePlayer(p);
  // ensure self exists
  if (!players.has(myId)) {
    addOrUpdatePlayer({ id: myId, name: m.name, color: m.color, x: 0, z: 0, ry: 0 });
  }
  applyPhase(m.phase, m.phaseEndsAt, m.ranking);
  // Pre-fill name input
  if (nameInput.value === '') nameInput.value = m.name;
});
net.on('playerJoin', (m) => {
  addOrUpdatePlayer(m.player);
});
net.on('playerLeave', (m) => removePlayer(m.id));
net.on('playerName', (m) => {
  const p = players.get(m.id);
  if (p) { p.name = m.name; refreshNameSprite(p); updatePlayersUI(); }
});
net.on('playerMove', (m) => {
  const p = players.get(m.id);
  if (!p) return;
  p.tx = m.x; p.tz = m.z; p.try = m.ry;
});
net.on('paint', (m) => {
  const owner = players.get(m.id);
  if (!owner) return;
  // Skip paints we already applied locally (own paints)
  if (m.id === myId) return;
  painter.paint(m.x, m.z, m.r, owner.color, m.id);
});
net.on('phase', (m) => applyPhase(m.phase, m.endsAt, m.ranking, m));
net.on('scores', (m) => {
  if (phase !== 'playing') return;
  phaseEndsAt = Date.now() + (m.remaining || 0);
  renderScoreboard(m.scores);
});
net.on('snapBack', (m) => {
  // Server rejected our move. Snap me back.
  const me = players.get(myId);
  if (!me) return;
  me.x = m.x; me.z = m.z;
  me.tx = m.x; me.tz = m.z;
  me.mesh.position.set(m.x, 0, m.z);
});
net.on('rejected', (m) => {
  alert('无法加入：' + (m.reason || '未知原因'));
});

function applyPhase(p, endsAt, ranking, fullMsg) {
  phase = p;
  phaseEndsAt = endsAt || 0;
  if (p === 'lobby') {
    overlay.classList.remove('hidden');
    result.classList.add('hidden');
    countdownEl.classList.add('hidden');
    timerEl.textContent = '--';
    scoreboardEl.innerHTML = '';
    painter.reset();
    crosshair.classList.remove('active');
  } else if (p === 'countdown') {
    overlay.classList.add('hidden');
    result.classList.add('hidden');
    countdownEl.classList.remove('hidden');
    painter.reset();
    // Snap players to their (server-spawned) positions
    if (fullMsg && fullMsg.players) {
      for (const sp of fullMsg.players) {
        const pp = players.get(sp.id);
        if (pp) {
          pp.x = sp.x; pp.z = sp.z; pp.ry = sp.ry || 0;
          pp.tx = sp.x; pp.tz = sp.z; pp.try = sp.ry || 0;
          if (pp.mesh) {
            pp.mesh.position.set(sp.x, 0, sp.z);
            pp.mesh.rotation.y = sp.ry || 0;
          }
        }
      }
    }
    crosshair.classList.add('active');
  } else if (p === 'playing') {
    overlay.classList.add('hidden');
    result.classList.add('hidden');
    countdownEl.classList.add('hidden');
    crosshair.classList.add('active');
  } else if (p === 'ended') {
    countdownEl.classList.add('hidden');
    crosshair.classList.remove('active');
    currentRanking = ranking || [];
    showResults(currentRanking);
  }
}

function showResults(ranking) {
  result.classList.remove('hidden');
  rankingEl.innerHTML = '';
  if (!ranking || ranking.length === 0) {
    resultTitleEl.textContent = '本局结束';
    return;
  }
  const winner = ranking[0];
  resultTitleEl.textContent = winner.id === myId ? '🏆 你赢了！' : `🏆 ${winner.name} 获胜`;
  ranking.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = 'rank-row' + (idx === 0 ? ' first' : '');
    row.innerHTML = `
      <div class="bar" style="width:${r.percent.toFixed(1)}%; background:${r.color}"></div>
      <div class="pos">#${idx + 1}</div>
      <div class="swatch" style="background:${r.color}"></div>
      <div class="name">${r.name}${r.id === myId ? ' (你)' : ''}</div>
      <div class="pct">${r.percent.toFixed(1)}%</div>
    `;
    rankingEl.appendChild(row);
  });
}

function renderScoreboard(scores) {
  scoreboardEl.innerHTML = '';
  // Sort by id for stable order, but show top 4
  const sorted = [...scores].sort((a, b) => b.percent - a.percent);
  for (const s of sorted) {
    const item = document.createElement('div');
    item.className = 'score-item';
    item.innerHTML = `<span class="score-swatch" style="background:${s.color}"></span><span>${s.name} ${s.percent.toFixed(1)}%</span>`;
    scoreboardEl.appendChild(item);
  }
}

// ----- Input -----
const keys = {};
let mouseAim = new THREE.Vector2(); // NDC
let firing = false;
let lastSentPaintAt = 0;
let lastSentMoveAt = 0;

window.addEventListener('keydown', (e) => {
  if (document.activeElement === nameInput) return;
  keys[e.code] = true;
  if (e.code === 'Space') { firing = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Space') firing = false;
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) firing = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
});
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseAim.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouseAim.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});

// Lobby controls
startBtn.addEventListener('click', () => {
  const name = (nameInput.value || '').trim();
  if (name) net.send({ type: 'name', name });
  net.send({ type: 'startRound' });
});
restartBtn.addEventListener('click', () => {
  net.send({ type: 'startRound' });
});
nameInput.addEventListener('change', () => {
  const name = (nameInput.value || '').trim();
  if (name) net.send({ type: 'name', name });
});

// ----- Movement & game loop -----
const PLAYER_SPEED = 5.5;
const PLAYER_RADIUS = 0.35;
const PAINT_RADIUS = 0.65;
const PAINT_REACH = 1.6;

const tmpVec = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aimPoint = new THREE.Vector3();

function getMouseAim() {
  raycaster.setFromCamera(mouseAim, camera);
  if (raycaster.ray.intersectPlane(aimPlane, aimPoint)) return aimPoint;
  return null;
}

function tryMove(me, dx, dz) {
  // Try the full move, then sliding along axes if blocked.
  const attempts = [
    [dx, dz],
    [dx, 0],
    [0, dz],
  ];
  for (const [ax, az] of attempts) {
    const nx = me.x + ax;
    const nz = me.z + az;
    if (canStandAt(me, nx, nz)) {
      me.x = nx; me.z = nz;
      return;
    }
  }
}

function canStandAt(me, x, z) {
  // Floor bounds
  const m = FLOOR_SIZE / 2 - PLAYER_RADIUS;
  if (x < -m || x > m || z < -m || z > m) return false;
  // House colliders (AABB inflated by player radius)
  for (const c of colliders) {
    if (
      x > c.minX - PLAYER_RADIUS && x < c.maxX + PLAYER_RADIUS &&
      z > c.minZ - PLAYER_RADIUS && z < c.maxZ + PLAYER_RADIUS
    ) return false;
  }
  // Enemy paint blocks during play
  if (phase === 'playing') {
    const owner = painter.ownerAt(x, z);
    if (owner !== 0 && owner !== myId) return false;
  }
  return true;
}

let prevTime = performance.now();
function animate(time) {
  const dt = Math.min(0.05, (time - prevTime) / 1000);
  prevTime = time;

  // ----- update local player -----
  const me = players.get(myId);
  if (me) {
    if (phase === 'playing' || phase === 'countdown') {
      // Compute movement vector from keys, in world axes (top-down style)
      let mx = 0, mz = 0;
      if (keys['KeyW'] || keys['ArrowUp'])    mz -= 1;
      if (keys['KeyS'] || keys['ArrowDown'])  mz += 1;
      if (keys['KeyA'] || keys['ArrowLeft'])  mx -= 1;
      if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
      const ml = Math.hypot(mx, mz);
      if (ml > 0) { mx /= ml; mz /= ml; }
      const dx = mx * PLAYER_SPEED * dt;
      const dz = mz * PLAYER_SPEED * dt;
      if (phase === 'playing' && (dx !== 0 || dz !== 0)) {
        tryMove(me, dx, dz);
      }

      // Face mouse-aim point (or movement direction if mouse not over canvas)
      const aim = getMouseAim();
      if (aim) {
        const yaw = Math.atan2(aim.x - me.x, aim.z - me.z);
        me.ry = yaw;
      } else if (ml > 0) {
        me.ry = Math.atan2(mx, mz);
      }
      me.mesh.position.set(me.x, 0, me.z);
      me.mesh.rotation.y = me.ry + Math.PI; // mesh faces +Z by default; flip to face aim

      // Send move (throttled)
      if (time - lastSentMoveAt > 50) {
        lastSentMoveAt = time;
        net.send({ type: 'move', x: me.x, z: me.z, ry: me.ry });
      }

      // Spray paint if firing
      if (firing && phase === 'playing' && time - lastSentPaintAt > 55) {
        lastSentPaintAt = time;
        // Paint point: in front of player
        const fx = me.x + Math.sin(me.ry) * PAINT_REACH;
        const fz = me.z + Math.cos(me.ry) * PAINT_REACH;
        // Apply locally (optimistic)
        painter.paint(fx, fz, PAINT_RADIUS, myColor, myId);
        net.send({ type: 'paint', x: fx, z: fz, r: PAINT_RADIUS });
      }
    }
  }

  // ----- update remote players (interpolated) -----
  for (const p of players.values()) {
    if (p.id === myId) continue;
    if (p.tx !== undefined) {
      p.x += (p.tx - p.x) * Math.min(1, dt * 12);
      p.z += (p.tz - p.z) * Math.min(1, dt * 12);
      p.ry = lerpAngle(p.ry || 0, p.try || 0, Math.min(1, dt * 12));
      if (p.mesh) {
        p.mesh.position.set(p.x, 0, p.z);
        p.mesh.rotation.y = p.ry + Math.PI;
      }
    }
  }

  // ----- camera follow -----
  if (me) {
    // Over-shoulder follow camera: ~5m up, ~7m behind, looking forward over player.
    const targetX = me.x;
    const targetY = 5.0;
    const targetZ = me.z + 7.0;
    camera.position.lerp(tmpVec.set(targetX, targetY, targetZ), Math.min(1, dt * 5));
    camera.lookAt(me.x, 1.5, me.z - 1.5);
  } else {
    camera.position.set(0, 6, 12);
    camera.lookAt(0, 1, 0);
  }

  // ----- timer & countdown UI -----
  const remaining = Math.max(0, phaseEndsAt - Date.now());
  if (phase === 'playing') {
    timerEl.textContent = (remaining / 1000).toFixed(1);
  } else if (phase === 'countdown') {
    const sec = Math.ceil(remaining / 1000);
    countdownEl.textContent = sec > 0 ? sec : 'GO!';
    countdownEl.classList.toggle('go', sec <= 0);
    timerEl.textContent = '--';
  } else if (phase === 'lobby' || phase === 'ended') {
    timerEl.textContent = '--';
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function fitRenderer() {
  const w = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
  const h = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 720);
  const pr = renderer.getPixelRatio();
  if (renderer.domElement.width === Math.floor(w * pr) &&
      renderer.domElement.height === Math.floor(h * pr)) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', fitRenderer);
fitRenderer();


requestAnimationFrame(animate);
