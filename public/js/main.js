import * as THREE from 'three';
import { buildHouse } from './scene.js';
import { Painter } from './painter.js';
import { Network } from './network.js';

// ----- World constants (must match server) -----
const FLOOR_SIZE = 40;
const FLOOR2_Y = 4.6;

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
scene.fog = new THREE.Fog(0x111118, 40, 110);

const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 200);
// The camera lives on a pivot that orbits the player's chest. Yaw rotates
// horizontally; pitch tilts up/down. Mouse delta drives both while pointer
// lock is active.
const cameraPivot = new THREE.Object3D();
cameraPivot.rotation.order = 'YXZ';
scene.add(cameraPivot);
cameraPivot.add(camera);
const CAMERA_DISTANCE = 6.8;
const CAMERA_NEAR_LIMIT = 1.5; // never pull camera closer than this to player
const CAMERA_DEFAULT_PITCH = -0.30;
camera.position.set(0, 0, CAMERA_DISTANCE);
let cameraYaw = 0;
let cameraPitch = CAMERA_DEFAULT_PITCH;  // tilted slightly down by default
let cameraDistanceCurrent = CAMERA_DISTANCE;
const PITCH_MIN = -0.55;       // ~32° down — enough to see floor, not lose horizon
const PITCH_MAX = 0.30;        // ~17° up — can spray walls/ceiling slightly

// Lights — moderate so ACES doesn't crush colors.
const hemi = new THREE.HemisphereLight(0xb8c5d8, 0x3a3045, 0.45);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffffff, 0.08);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff1d0, 0.75);
sun.position.set(20, 40, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -25; sun.shadow.camera.right = 25;
sun.shadow.camera.top = 25; sun.shadow.camera.bottom = -25;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 100;
sun.shadow.bias = -0.0005;
scene.add(sun);

// World
const houseData = buildHouse(FLOOR_SIZE, FLOOR2_Y);
const { group: house, colliders, fadables, ramp: rampDef } = houseData;
scene.add(house);

const painter = new Painter({
  floorSize: FLOOR_SIZE,
  floors: 2,
  floorYs: [0, FLOOR2_Y],
  resolution: 1024,
  gridResolution: 256,
});
for (const m of painter.getMeshes()) scene.add(m);

for (const m of fadables) {
  m.userData.fadeTarget = 1.0;
  m.material.transparent = false;
  m.material.opacity = 1.0;
}

// ---------- Wall splat (decal) painter ----------
const splatTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 60);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.92)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(64, 64, 60, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const wallSplatGroup = new THREE.Group();
scene.add(wallSplatGroup);
const MAX_WALL_SPLATS = 1000;
const wallSplats = [];
const SPLAT_PLANE_NORMAL = new THREE.Vector3(0, 0, 1);

function spawnWallSplat(point, normal, colorHex, sizeMeters = 1.1) {
  const mat = new THREE.MeshBasicMaterial({
    map: splatTexture,
    color: parseInt(colorHex.slice(1), 16),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const geo = new THREE.PlaneGeometry(sizeMeters, sizeMeters);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(point).addScaledVector(normal, 0.015);
  mesh.quaternion.setFromUnitVectors(SPLAT_PLANE_NORMAL, normal);
  mesh.rotateZ(Math.random() * Math.PI * 2);
  wallSplatGroup.add(mesh);
  wallSplats.push(mesh);
  if (wallSplats.length > MAX_WALL_SPLATS) {
    const old = wallSplats.shift();
    wallSplatGroup.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
}

function clearWallSplats() {
  for (const m of wallSplats) {
    wallSplatGroup.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  }
  wallSplats.length = 0;
}

// ----- Game state -----
const players = new Map();
let myId = null;
let myColor = '#ffffff';
let phase = 'lobby';
let phaseEndsAt = 0;
let currentRanking = null;
let respawnSeconds = 3;
let myRespawnAt = 0;
let myDeadKillerId = 0;

// ----- Avatars -----
function colorToInt(hex) { return parseInt(hex.slice(1), 16); }

function createAvatar(player) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: colorToInt(player.color), roughness: 0.4, metalness: 0.1,
    emissive: colorToInt(player.color), emissiveIntensity: 0.15,
  });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.7, 6, 12), bodyMat);
  body.position.y = 0.7; body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe2c2, roughness: 0.7 }),
  );
  head.position.y = 1.45; head.castShadow = true;
  group.add(head);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: colorToInt(player.color) }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.45, 0.22);
  group.add(nose);

  const tank = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.14, 0.5, 12),
    new THREE.MeshStandardMaterial({ color: colorToInt(player.color), roughness: 0.3, metalness: 0.7 }),
  );
  tank.position.set(-0.18, 0.95, -0.32); tank.rotation.x = 0.2;
  group.add(tank);
  const tank2 = tank.clone(); tank2.position.x = 0.18; group.add(tank2);

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
    existing = {
      ...p,
      mesh: view.mesh, body: view.body, nameSprite: view.nameSprite,
      tx: p.x, tz: p.z, try: p.ry || 0,
      tFloor: p.floor || 0, floor: p.floor || 0,
      dead: !!p.dead,
      lastFootprintAt: 0, lastFootprintX: p.x, lastFootprintZ: p.z,
    };
    players.set(p.id, existing);
  } else {
    existing.tx = p.x; existing.tz = p.z; existing.try = p.ry || 0;
    if (Number.isFinite(p.floor)) existing.tFloor = p.floor;
    if (p.dead !== undefined) existing.dead = !!p.dead;
    if (p.name && p.name !== existing.name) {
      existing.name = p.name;
      refreshNameSprite(existing);
    }
  }
  setAvatarVisibility(existing);
  updatePlayersUI();
  return existing;
}

function setAvatarVisibility(p) {
  if (!p.mesh) return;
  p.mesh.visible = !p.dead;
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

net.on('open', () => statusEl.textContent = '已连接，等待加入…');
net.on('close', () => statusEl.textContent = '与服务器断开，请刷新页面');
net.on('welcome', (m) => {
  myId = m.id; myColor = m.color;
  respawnSeconds = m.respawnSeconds || 3;
  for (const p of m.players) addOrUpdatePlayer(p);
  if (!players.has(myId)) {
    addOrUpdatePlayer({ id: myId, name: m.name, color: m.color, x: 0, z: 0, ry: 0, floor: 0 });
  }
  applyPhase(m.phase, m.phaseEndsAt, m.ranking);
  if (nameInput.value === '') nameInput.value = m.name;
});
net.on('playerJoin', (m) => addOrUpdatePlayer(m.player));
net.on('playerLeave', (m) => removePlayer(m.id));
net.on('playerName', (m) => {
  const p = players.get(m.id);
  if (p) { p.name = m.name; refreshNameSprite(p); updatePlayersUI(); }
});
net.on('playerMove', (m) => {
  const p = players.get(m.id);
  if (!p) return;
  p.tx = m.x; p.tz = m.z; p.try = m.ry; p.tFloor = m.floor || 0;
  if (Number.isFinite(m.y)) p.ty = m.y;
});
net.on('paint', (m) => {
  const owner = players.get(m.id);
  if (!owner) return;
  if (m.id === myId) return;
  paintStroke(m.fromX, m.fromZ, m.fromFloor, m.x, m.z, m.floor || 0, owner.color, m.id, m.r);
});
net.on('footprint', (m) => {
  const owner = players.get(m.id);
  if (!owner) return;
  if (m.id === myId) return;
  paintStroke(m.fromX, m.fromZ, m.fromFloor, m.x, m.z, m.floor || 0, owner.color, m.id, m.r);
});
net.on('decal', (m) => {
  const owner = players.get(m.id);
  if (!owner) return;
  if (m.id === myId) return;
  spawnWallSplat(
    new THREE.Vector3(m.x, m.y, m.z),
    new THREE.Vector3(m.nx, m.ny, m.nz),
    owner.color, m.r,
  );
});
net.on('died', (m) => {
  myRespawnAt = Date.now() + (m.respawnIn || respawnSeconds) * 1000;
  myDeadKillerId = m.killerId || 0;
  const me = players.get(myId);
  if (me) { me.dead = true; setAvatarVisibility(me); }
  // Camera shake / overlay handled in animate
});
net.on('respawn', (m) => {
  const me = players.get(myId);
  if (!me) return;
  me.x = m.x; me.z = m.z; me.tx = m.x; me.tz = m.z;
  me.floor = m.floor || 0; me.tFloor = me.floor;
  me.ry = m.ry || 0; me.try = me.ry;
  me.onRamp = false;
  me.y = me.floor === 1 ? FLOOR2_Y : 0;
  me.dead = false;
  setAvatarVisibility(me);
  myRespawnAt = 0;
});
net.on('playerDied', (m) => {
  const p = players.get(m.id);
  if (!p) return;
  p.dead = true; setAvatarVisibility(p);
});
net.on('playerRespawn', (m) => {
  const p = players.get(m.id);
  if (!p) return;
  p.x = m.x; p.z = m.z; p.tx = m.x; p.tz = m.z;
  p.floor = m.floor; p.tFloor = m.floor; p.ry = m.ry; p.try = m.ry;
  p.dead = false;
  setAvatarVisibility(p);
});
net.on('phase', (m) => applyPhase(m.phase, m.endsAt, m.ranking, m));
net.on('scores', (m) => {
  if (phase !== 'playing') return;
  phaseEndsAt = Date.now() + (m.remaining || 0);
  renderScoreboard(m.scores);
});
net.on('rejected', (m) => alert('无法加入：' + (m.reason || '未知原因')));

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
    clearWallSplats();
    crosshair.classList.remove('active');
    hideDeath();
  } else if (p === 'countdown') {
    overlay.classList.add('hidden');
    result.classList.add('hidden');
    countdownEl.classList.remove('hidden');
    painter.reset();
    clearWallSplats();
    if (fullMsg && fullMsg.players) {
      for (const sp of fullMsg.players) {
        const pp = players.get(sp.id);
        if (pp) {
          pp.x = sp.x; pp.z = sp.z; pp.ry = sp.ry || 0;
          pp.tx = sp.x; pp.tz = sp.z; pp.try = sp.ry || 0;
          pp.floor = sp.floor || 0; pp.tFloor = pp.floor;
          pp.onRamp = false;
          pp.y = pp.floor === 1 ? FLOOR2_Y : 0;
          pp.ty = pp.y;
          pp.dead = false;
          if (pp.mesh) {
            pp.mesh.position.set(sp.x, currentY(pp), sp.z);
            pp.mesh.rotation.y = sp.ry || 0;
          }
          setAvatarVisibility(pp);
        }
      }
    }
    crosshair.classList.add('active');
    hideDeath();
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
    hideDeath();
  }
}

function showResults(ranking) {
  result.classList.remove('hidden');
  rankingEl.innerHTML = '';
  if (!ranking || ranking.length === 0) {
    resultTitleEl.textContent = '本局结束'; return;
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
  const sorted = [...scores].sort((a, b) => b.percent - a.percent);
  for (const s of sorted) {
    const item = document.createElement('div');
    item.className = 'score-item';
    item.innerHTML = `<span class="score-swatch" style="background:${s.color}"></span><span>${s.name} ${s.percent.toFixed(1)}%</span>`;
    scoreboardEl.appendChild(item);
  }
}

// Death overlay (simple HTML)
let deathEl = document.getElementById('death');
if (!deathEl) {
  deathEl = document.createElement('div');
  deathEl.id = 'death';
  deathEl.className = 'death-overlay hidden';
  deathEl.innerHTML = `<div class="death-panel"><div class="death-title">💀 你被涂掉了</div><div class="death-sub">复活倒计时 <span id="deathTimer">3.0</span> 秒</div></div>`;
  document.body.appendChild(deathEl);
}
const deathTimerEl = () => document.getElementById('deathTimer');

function showDeath() { deathEl.classList.remove('hidden'); }
function hideDeath() { deathEl.classList.add('hidden'); }

// ----- Input -----
const keys = {};
let mouseAim = new THREE.Vector2();
let firing = false;
let lastSentPaintAt = 0;
let lastSentMoveAt = 0;
let lastSentFootprintAt = 0;
let lastFootprintX = 0, lastFootprintZ = 0;

window.addEventListener('keydown', (e) => {
  if (document.activeElement === nameInput) return;
  keys[e.code] = true;
  if (e.code === 'Space') { firing = true; e.preventDefault(); }
  // V resets view to align with player's facing + default pitch (panic button
  // if the camera ends up somewhere disorienting).
  if (e.code === 'KeyV') {
    const me = players.get(myId);
    cameraYaw = me ? (me.ry || 0) : 0;
    cameraPitch = CAMERA_DEFAULT_PITCH;
  }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Space') firing = false;
});
canvas.addEventListener('mousedown', (e) => { if (e.button === 0) firing = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });

// Camera-rotation rates (keyboard-driven so trackpad users don't have to
// fight pointer lock). Q/E rotate yaw left/right; R/F tilt pitch up/down.
const YAW_RATE = 2.4;          // rad/s when Q or E held
const PITCH_RATE = 1.4;        // rad/s when R or F held

window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseAim.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouseAim.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});

startBtn.addEventListener('click', () => {
  const name = (nameInput.value || '').trim();
  if (name) net.send({ type: 'name', name });
  net.send({ type: 'startRound' });
});
restartBtn.addEventListener('click', () => net.send({ type: 'startRound' }));
nameInput.addEventListener('change', () => {
  const name = (nameInput.value || '').trim();
  if (name) net.send({ type: 'name', name });
});

// ----- Movement helpers -----
const PLAYER_SPEED = 6.2;
const PLAYER_RADIUS = 0.36;
const PAINT_RADIUS = 0.7;
const PAINT_REACH = 1.6;
const MAX_PAINT_REACH = 11.0;
const FOOTPRINT_STEP = 0.55;       // distance walked between footprint stamps
const FOOTPRINT_RADIUS = 0.34;

function isOnRamp(x, z) {
  return x >= rampDef.xMin && x <= rampDef.xMax &&
         z >= rampDef.zMin && z <= rampDef.zMax;
}

function rampYAt(z) {
  const t = (z - rampDef.zMin) / (rampDef.zMax - rampDef.zMin);
  return Math.max(0, Math.min(1, t)) * rampDef.topY;
}

function currentY(p) {
  if (p.onRamp) return rampYAt(p.z);
  // Remote players: server includes y in their move payload (set into p.y);
  // fall back to the floor-based default if we haven't received one yet.
  if (p.id !== myId && Number.isFinite(p.y)) return p.y;
  return p.floor === 1 ? FLOOR2_Y : 0;
}

function tryMove(me, dx, dz) {
  const attempts = [[dx, dz], [dx, 0], [0, dz]];
  for (const [ax, az] of attempts) {
    const nx = me.x + ax;
    const nz = me.z + az;
    if (canStandAt(me, nx, nz)) {
      const oldZ = me.z;
      const wasInRamp = isOnRamp(me.x, oldZ);
      const nowInRamp = isOnRamp(nx, nz);

      // Ramp state machine. me.onRamp is true only while standing on the
      // ramp surface. Walking under the ramp on the ground floor leaves it
      // false, so the player is NOT teleported up by the Y interpolation.
      if (!wasInRamp && nowInRamp) {
        // Just stepped into the ramp footprint — only treat as on-ramp if
        // we crossed a valid endpoint in the right direction.
        if (me.floor === 0 && oldZ < rampDef.zMin && nz >= rampDef.zMin) {
          me.onRamp = true;        // ground floor entering north end going +Z (going UP)
        } else if (me.floor === 1 && oldZ > rampDef.zMax && nz <= rampDef.zMax) {
          me.onRamp = true;        // upstairs entering south end going -Z (going DOWN)
        } else {
          me.onRamp = false;       // walking under (ground) or skirting the hole rails (upstairs)
        }
      } else if (wasInRamp && !nowInRamp) {
        // Just stepped out of ramp footprint
        if (me.onRamp) {
          if (nz < rampDef.zMin) me.floor = 0;
          else if (nz > rampDef.zMax) me.floor = 1;
        }
        me.onRamp = false;
      }

      me.x = nx; me.z = nz;
      return;
    }
  }
}

// Self-extricate when the player ends up inside (or on the wrong side of)
// a collider — e.g. floor change put them in a wall, or a server snap pushed
// them into a corner. Sweeps a spiral of candidate offsets and teleports to
// the first valid one.
function unstickIfNeeded(me) {
  if (canStandAt(me, me.x, me.z)) return;
  for (let r = 0.4; r < 6; r += 0.4) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const tx = me.x + Math.cos(a) * r;
      const tz = me.z + Math.sin(a) * r;
      if (canStandAt(me, tx, tz)) {
        me.x = tx; me.z = tz;
        return;
      }
    }
  }
}

function canStandAt(me, x, z) {
  const m = FLOOR_SIZE / 2 - PLAYER_RADIUS;
  if (x < -m || x > m || z < -m || z > m) return false;
  const targetFloor = isOnRamp(x, z) ? me.floor : me.floor;
  for (const c of colliders) {
    if (c.floor !== targetFloor) continue;
    if (
      x > c.minX - PLAYER_RADIUS && x < c.maxX + PLAYER_RADIUS &&
      z > c.minZ - PLAYER_RADIUS && z < c.maxZ + PLAYER_RADIUS
    ) return false;
  }
  return true;
}

// ----- Spray -----
const tmpVec = new THREE.Vector3();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aimPoint = new THREE.Vector3();
const raycaster = new THREE.Raycaster();

function getMouseAim(targetY) {
  raycaster.setFromCamera(mouseAim, camera);
  aimPlane.constant = -targetY;     // floor at targetY
  if (raycaster.ray.intersectPlane(aimPlane, aimPoint)) return aimPoint;
  return null;
}

const sprayRay = new THREE.Raycaster();
const sprayOrigin = new THREE.Vector3();
const sprayDir = new THREE.Vector3();
const sprayAimVec = new THREE.Vector3();

function emitSpray(me) {
  const meY = currentY(me);
  const aim = getMouseAim(meY);
  if (!aim) {
    // Fallback: spray in front of player on current floor
    const fx = me.x + Math.sin(me.ry) * PAINT_REACH;
    const fz = me.z + Math.cos(me.ry) * PAINT_REACH;
    painter.paint(fx, fz, PAINT_RADIUS, myColor, myId, me.floor);
    net.send({ type: 'paint', x: fx, z: fz, r: PAINT_RADIUS, floor: me.floor });
    return;
  }
  sprayOrigin.set(me.x, meY + 1.2, me.z);
  sprayAimVec.copy(aim);
  sprayDir.subVectors(sprayAimVec, sprayOrigin).normalize();
  sprayRay.set(sprayOrigin, sprayDir);
  sprayRay.far = MAX_PAINT_REACH + 6;
  const candidates = [...painter.getMeshes(), ...fadables];
  const hits = sprayRay.intersectObjects(candidates, false);
  if (hits.length === 0) return;
  const hit = hits[0];
  const floorIdx = hit.object.userData.floor;
  if (Number.isFinite(floorIdx)) {
    let fx = hit.point.x, fz = hit.point.z;
    const dx = fx - me.x, dz = fz - me.z;
    const d = Math.hypot(dx, dz);
    if (d > MAX_PAINT_REACH) {
      fx = me.x + dx * MAX_PAINT_REACH / d;
      fz = me.z + dz * MAX_PAINT_REACH / d;
    }
    painter.paint(fx, fz, PAINT_RADIUS, myColor, myId, floorIdx);
    net.send({ type: 'paint', x: fx, z: fz, r: PAINT_RADIUS, floor: floorIdx });
  } else {
    const point = hit.point;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    spawnWallSplat(point, normal, myColor, PAINT_RADIUS * 1.7);
    net.send({
      type: 'decal',
      x: point.x, y: point.y, z: point.z,
      nx: normal.x, ny: normal.y, nz: normal.z,
      r: PAINT_RADIUS * 1.7,
    });
  }
}

// ----- Camera collision -----
// Cast a ray from the pivot (player's chest) outward to where the camera
// wants to sit; if a wall or piece of furniture is in the way, pull the
// camera in along its local +Z axis until it's just in front of the obstacle.
const camRaycaster = new THREE.Raycaster();
const camRayOrigin = new THREE.Vector3();
const camRayDesired = new THREE.Vector3();
const camRayDir = new THREE.Vector3();

function applyCameraCollision(dt) {
  cameraPivot.getWorldPosition(camRayOrigin);
  camRayDesired.set(0, 0, CAMERA_DISTANCE).applyMatrix4(cameraPivot.matrixWorld);
  camRayDir.subVectors(camRayDesired, camRayOrigin);
  const fullDist = camRayDir.length();
  if (fullDist < 0.01) return;
  camRayDir.divideScalar(fullDist);
  camRaycaster.set(camRayOrigin, camRayDir);
  camRaycaster.far = fullDist;
  const hits = camRaycaster.intersectObjects(fadables, false);
  let target = CAMERA_DISTANCE;
  if (hits.length > 0) {
    target = Math.max(CAMERA_NEAR_LIMIT, hits[0].distance - 0.3);
  }
  // Snap quickly toward closer (don't clip), lerp back outward smoothly.
  if (target < cameraDistanceCurrent) {
    cameraDistanceCurrent = target;
  } else {
    cameraDistanceCurrent += (target - cameraDistanceCurrent) * Math.min(1, dt * 6);
  }
  camera.position.z = cameraDistanceCurrent;
}

// ----- Occlusion fade -----
const occRaycaster = new THREE.Raycaster();
const occPlayerPos = new THREE.Vector3();
const occCamDir = new THREE.Vector3();
const FADE_OPACITY = 0.1;
const FADE_RATE = 12;

function updateOcclusion(me, dt) {
  for (const m of fadables) m.userData.fadeTarget = 1.0;
  occPlayerPos.set(me.x, currentY(me) + 1.0, me.z);
  occCamDir.subVectors(occPlayerPos, camera.position);
  const dist = occCamDir.length();
  if (dist > 0.05) {
    occCamDir.divideScalar(dist);
    occRaycaster.set(camera.position, occCamDir);
    occRaycaster.far = dist;
    const hits = occRaycaster.intersectObjects(fadables, false);
    for (const h of hits) h.object.userData.fadeTarget = FADE_OPACITY;
  }
  const t = Math.min(1, dt * FADE_RATE);
  for (const m of fadables) {
    const target = m.userData.fadeTarget;
    const cur = m.material.opacity;
    if (Math.abs(cur - target) > 0.001) {
      m.material.opacity = cur + (target - cur) * t;
      m.material.transparent = m.material.opacity < 0.99;
    }
  }
}

// ----- Game loop -----
let prevTime = performance.now();
function animate(time) {
  const dt = Math.min(0.05, (time - prevTime) / 1000);
  prevTime = time;

  const me = players.get(myId);
  if (me) {
    if ((phase === 'playing' || phase === 'countdown') && !me.dead) {
      // Camera rotation via keyboard (trackpad-friendly).
      if (keys['KeyQ']) cameraYaw   += YAW_RATE * dt;
      if (keys['KeyE']) cameraYaw   -= YAW_RATE * dt;
      const pitchInput = (keys['KeyR'] ? 1 : 0) - (keys['KeyF'] ? 1 : 0);
      if (pitchInput !== 0) {
        cameraPitch += pitchInput * PITCH_RATE * dt;
      } else {
        // Auto-relax pitch back toward default when nothing held — keeps the
        // horizon line stable so the player doesn't drift into a top-down or
        // sky-view orientation by accident.
        const decay = (CAMERA_DEFAULT_PITCH - cameraPitch) * Math.min(1, dt * 1.6);
        cameraPitch += decay;
      }
      if (cameraPitch < PITCH_MIN) cameraPitch = PITCH_MIN;
      if (cameraPitch > PITCH_MAX) cameraPitch = PITCH_MAX;

      let mx = 0, mz = 0;
      if (keys['KeyW'] || keys['ArrowUp'])    mz -= 1;
      if (keys['KeyS'] || keys['ArrowDown'])  mz += 1;
      if (keys['KeyA'] || keys['ArrowLeft'])  mx -= 1;
      if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
      const ml = Math.hypot(mx, mz);
      if (ml > 0) { mx /= ml; mz /= ml; }
      // Movement is camera-relative: rotate input vector by cameraYaw so W is
      // always "where the camera is looking" regardless of view rotation.
      const cy = Math.cos(cameraYaw), sy = Math.sin(cameraYaw);
      const wx = mx * cy + mz * sy;
      const wz = -mx * sy + mz * cy;
      const dx = wx * PLAYER_SPEED * dt;
      const dz = wz * PLAYER_SPEED * dt;

      const oldX = me.x, oldZ = me.z;
      if (phase === 'playing' && (dx !== 0 || dz !== 0)) {
        tryMove(me, dx, dz);
      }
      // Safety net for any stuck state (collider overlap or server snap).
      if (phase === 'playing') unstickIfNeeded(me);

      // Check enemy color (death) — only on actual floors, not on ramp
      if (phase === 'playing' && !isOnRamp(me.x, me.z)) {
        const owner = painter.ownerAt(me.x, me.z, me.floor);
        if (owner !== 0 && owner !== myId) {
          // server is authoritative; client also predicts to feel snappy
          // Don't actually set me.dead here — server will send 'died' message.
          // But we can stop sending move updates immediately once over enemy paint.
        }
      }

      // Aim & facing — face the floor projection of the cursor. If the cursor
      // somehow doesn't intersect the floor (extreme camera pitch), fall back
      // to the camera's forward direction.
      const aim = getMouseAim(currentY(me));
      if (aim) {
        me.ry = Math.atan2(aim.x - me.x, aim.z - me.z);
      } else if (ml > 0) {
        me.ry = Math.atan2(wx, wz);
      } else {
        me.ry = cameraYaw;
      }
      const meY = currentY(me);
      me.mesh.position.set(me.x, meY, me.z);
      me.mesh.rotation.y = me.ry + Math.PI;

      // Send move (throttled). Include y so other clients can render us at
      // the correct height while transitioning between floors via the ramp.
      if (time - lastSentMoveAt > 50) {
        lastSentMoveAt = time;
        net.send({
          type: 'move',
          x: me.x, y: currentY(me), z: me.z,
          ry: me.ry, floor: me.floor,
        });
      }

      // Footprints: every FOOTPRINT_STEP meters along the trail, drop a
      // stroke from the previous stamp to the current position so the path
      // reads as a continuous trail rather than discrete dots.
      if (phase === 'playing' && !isOnRamp(me.x, me.z)) {
        const fdx = me.x - lastFootprintX;
        const fdz = me.z - lastFootprintZ;
        const moved = Math.hypot(fdx, fdz);
        if (moved > FOOTPRINT_STEP && time - lastSentFootprintAt > 60) {
          lastSentFootprintAt = time;
          const fromX = lastFootprintX, fromZ = lastFootprintZ;
          paintStroke(fromX, fromZ, me.floor, me.x, me.z, me.floor, myColor, myId, FOOTPRINT_RADIUS);
          net.send({
            type: 'footprint',
            x: me.x, z: me.z, r: FOOTPRINT_RADIUS, floor: me.floor,
            fromX, fromZ, fromFloor: me.floor,
          });
          lastFootprintX = me.x; lastFootprintZ = me.z;
        }
      }

      if (firing && phase === 'playing' && time - lastSentPaintAt > 32) {
        lastSentPaintAt = time;
        emitSpray(me);
      }
      if (!firing) {
        // Reset the stroke anchor on key/button release so a new burst starts
        // fresh rather than connecting to wherever we last stopped.
        lastSprayX = null; lastSprayZ = null; lastSprayFloor = null;
      }
    } else if (me.dead) {
      // Keep avatar pinned at last position while dead
      if (me.mesh) {
        me.mesh.position.set(me.x, currentY(me), me.z);
      }
    }
  }

  // Remote players (interpolated)
  for (const p of players.values()) {
    if (p.id === myId) continue;
    if (p.tx !== undefined) {
      const k = Math.min(1, dt * 12);
      p.x += (p.tx - p.x) * k;
      p.z += (p.tz - p.z) * k;
      if (Number.isFinite(p.ty)) {
        if (!Number.isFinite(p.y)) p.y = p.ty;
        p.y += (p.ty - p.y) * k;
      }
      p.ry = lerpAngle(p.ry || 0, p.try || 0, k);
      if (Number.isFinite(p.tFloor)) p.floor = p.tFloor;
      if (p.mesh) {
        p.mesh.position.set(p.x, currentY(p), p.z);
        p.mesh.rotation.y = p.ry + Math.PI;
      }
    }
  }

  // Camera follow — pivot orbits player's chest, Q/E/R/F drive its rotation.
  if (me) {
    const meY = currentY(me);
    cameraPivot.position.lerp(
      tmpVec.set(me.x, meY + 1.4, me.z),
      Math.min(1, dt * 12),
    );
    cameraPivot.rotation.set(cameraPitch, cameraYaw, 0, 'YXZ');
    cameraPivot.updateMatrixWorld(true);
    applyCameraCollision(dt);
    if (!me.dead) updateOcclusion(me, dt);
  } else {
    cameraPivot.position.set(0, 1.4, 0);
    cameraPivot.rotation.set(cameraPitch, cameraYaw, 0, 'YXZ');
    cameraPivot.updateMatrixWorld(true);
  }

  // Timer / countdown / death UI
  const remaining = Math.max(0, phaseEndsAt - Date.now());
  if (phase === 'playing') {
    timerEl.textContent = (remaining / 1000).toFixed(1);
  } else if (phase === 'countdown') {
    const sec = Math.ceil(remaining / 1000);
    countdownEl.textContent = sec > 0 ? sec : 'GO!';
    countdownEl.classList.toggle('go', sec <= 0);
    timerEl.textContent = '--';
  } else {
    timerEl.textContent = '--';
  }

  if (myRespawnAt > 0) {
    const left = Math.max(0, (myRespawnAt - Date.now()) / 1000);
    showDeath();
    const dt2 = deathTimerEl();
    if (dt2) dt2.textContent = left.toFixed(1);
    if (left <= 0) hideDeath();
  } else {
    hideDeath();
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

window.__game = {
  scene, camera, renderer, players, painter, house, fadables,
  wallSplatGroup, spawnWallSplat, updateOcclusion, emitSpray,
  THREE,
  getMe: () => players.get(myId),
};

requestAnimationFrame(animate);
