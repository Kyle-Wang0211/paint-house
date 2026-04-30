const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ----- World layout -----
const FLOOR_SIZE = 40;          // meters per side, square footprint
const FLOORS = 2;               // 0 = ground, 1 = upstairs
const FLOOR2_Y = 4.6;           // height of the upstairs slab
const GRID = 256;
const ROUND_SECONDS = 75;
const COUNTDOWN_SECONDS = 3;
const RESPAWN_SECONDS = 3;

// Stair ramp: a single straight ramp running along +Z, going from floor 0
// at z = -RAMP_LEN/2 to floor 1 at z = RAMP_LEN/2. Centered at x = RAMP_X.
const RAMP_X_MIN = -2.5;
const RAMP_X_MAX = 2.5;
const RAMP_Z_BOTTOM = -2;       // ground entrance
const RAMP_Z_TOP = 8;           // upstairs landing
const RAMP_LEN = RAMP_Z_TOP - RAMP_Z_BOTTOM;

// 15 distinct colours so a single round can hold 15 players. Hand-spaced
// around the hue wheel and kept saturated/bright so paint stays readable
// on the dark wood floor.
const PLAYER_COLORS = [
  '#ff3a3a', '#ff8a3a', '#ffd23a', '#a8ff3a',
  '#3aff5c', '#3affa8', '#3affd4', '#36c2ff',
  '#3a8aff', '#5c5cff', '#a85cff', '#ff5cf0',
  '#ff3b6b', '#ff5ca8', '#c0ff3a',
];

// ----- Game state -----
const players = new Map();      // id -> player
let nextId = 1;
let phase = 'lobby';            // 'lobby' | 'countdown' | 'playing' | 'ended'
let phaseEndsAt = 0;
let lastRanking = null;

const grids = [
  new Uint8Array(GRID * GRID),  // floor 0
  new Uint8Array(GRID * GRID),  // floor 1
];

function clearGrids() { for (const g of grids) g.fill(0); }

function worldToCell(x, z) {
  const u = (x + FLOOR_SIZE / 2) / FLOOR_SIZE;
  const v = (z + FLOOR_SIZE / 2) / FLOOR_SIZE;
  return { cx: Math.floor(u * GRID), cz: Math.floor(v * GRID) };
}

function stampPaint(playerId, x, z, r, floor) {
  if (floor < 0 || floor >= FLOORS) return;
  const grid = grids[floor];
  const cellsPerMeter = GRID / FLOOR_SIZE;
  const rc = r * cellsPerMeter;
  const { cx, cz } = worldToCell(x, z);
  const r2 = rc * rc;
  const minX = Math.max(0, Math.floor(cx - rc));
  const maxX = Math.min(GRID - 1, Math.ceil(cx + rc));
  const minZ = Math.max(0, Math.floor(cz - rc));
  const maxZ = Math.min(GRID - 1, Math.ceil(cz + rc));
  for (let zi = minZ; zi <= maxZ; zi++) {
    for (let xi = minX; xi <= maxX; xi++) {
      const dx = xi - cx;
      const dz = zi - cz;
      if (dx * dx + dz * dz <= r2) {
        grid[zi * GRID + xi] = playerId;
      }
    }
  }
}

// Erase paint inside a circle. Used to neutralise the cells under a
// respawning player so they don't get killed the instant their invuln
// expires when the whole spawn area has been blanketed by an enemy.
function erasePaint(x, z, r, floor) {
  stampPaint(0, x, z, r, floor);
}

function sampleColorAt(x, z, floor) {
  if (floor < 0 || floor >= FLOORS) return 0;
  const { cx, cz } = worldToCell(x, z);
  if (cx < 0 || cx >= GRID || cz < 0 || cz >= GRID) return 0;
  return grids[floor][cz * GRID + cx];
}

function isOnRamp(x, z) {
  return x >= RAMP_X_MIN && x <= RAMP_X_MAX && z >= RAMP_Z_BOTTOM && z <= RAMP_Z_TOP;
}

function rampY(z) {
  const t = (z - RAMP_Z_BOTTOM) / RAMP_LEN;
  return Math.max(0, Math.min(1, t)) * FLOOR2_Y;
}

function computeScores() {
  const counts = new Map();
  for (const grid of grids) {
    for (let i = 0; i < grid.length; i++) {
      const id = grid[i];
      if (id === 0) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const total = GRID * GRID * FLOORS;
  const result = [];
  for (const [id, c] of counts) {
    const player = players.get(id);
    if (!player) continue;
    result.push({
      id, name: player.name, color: player.color,
      cells: c, percent: (c / total) * 100,
    });
  }
  for (const p of players.values()) {
    if (!result.find(r => r.id === p.id)) {
      result.push({ id: p.id, name: p.name, color: p.color, cells: 0, percent: 0 });
    }
  }
  result.sort((a, b) => b.cells - a.cells);
  return result;
}

function broadcast(msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function send(player, msg) {
  if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, z: p.z, ry: p.ry, floor: p.floor, dead: !!p.dead, ready: !!p.ready };
}

function pickColor() {
  const used = new Set([...players.values()].map(p => p.color));
  for (const c of PLAYER_COLORS) if (!used.has(c)) return c;
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

// 15 spawn slots in the south room on floor 0, enough for the full
// PLAYER_COLORS roster. Avoid the staircase x-range (x ∈ [-2.5, 2.5])
// entirely, and stay clear of nearby furniture (TV at x ∈ [2, 6]
// z ∈ [19, 19.6]; sofa at x ∈ [5.3, 10.7] z ∈ [11.3, 12.7]; kitchen
// counter at x ∈ [-11.1, -10.1]). Players face north by default.
const SPAWN_SLOTS = [
  // Row z=18.2 — closest to south wall
  { x: -7.5, z: 18.2 }, { x: -4.0, z: 18.2 }, { x:  4.0, z: 18.2 }, { x:  7.5, z: 18.2 },
  // Row z=17.5
  { x: -7.5, z: 17.5 }, { x: -4.0, z: 17.5 }, { x:  4.0, z: 17.5 }, { x:  7.5, z: 17.5 },
  // Row z=16
  { x: -7.5, z: 16.0 }, { x: -4.0, z: 16.0 }, { x:  4.0, z: 16.0 }, { x:  7.5, z: 16.0 },
  // Row z=14.5 — closest to ramp top, last to be assigned
  { x: -7.5, z: 14.5 }, { x: -4.0, z: 14.5 }, { x:  4.0, z: 14.5 },
];

function spawnPosition(seed) {
  const slot = SPAWN_SLOTS[((seed % SPAWN_SLOTS.length) + SPAWN_SLOTS.length) % SPAWN_SLOTS.length];
  return { x: slot.x, z: slot.z, floor: 0, ry: Math.PI };
}

// Pick a spawn slot that isn't covered by enemy paint. If every slot is
// enemy-coloured (everything's been blanketed), fall back to a random one
// — the caller still grants invulnerability so the player gets a window to
// move out before the next paint check kills them.
function chooseSafeSpawnSlot(player) {
  const indices = SPAWN_SLOTS.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  for (const i of indices) {
    const slot = SPAWN_SLOTS[i];
    const owner = sampleColorAt(slot.x, slot.z, 0);
    if (owner === 0 || owner === player.id) return slot;
  }
  return SPAWN_SLOTS[indices[0]];
}

const RESPAWN_INVULN_MS = 1500;

function killPlayer(player, killerId) {
  if (player.dead) return;
  player.dead = true;
  player.deadUntil = Date.now() + RESPAWN_SECONDS * 1000;
  player.killerId = killerId || 0;
  send(player, { type: 'died', killerId: killerId || 0, respawnIn: RESPAWN_SECONDS });
  broadcast({ type: 'playerDied', id: player.id, killerId: killerId || 0 }, player.id);
}

const RESPAWN_CLEAR_RADIUS = 0.9;   // metres; > player radius (0.36) so a
                                    // standing player isn't on enemy paint.
function respawnPlayer(player) {
  // Prefer a slot not covered by enemy paint, and grant a brief invuln
  // window in case every slot is already painted-over.
  const slot = chooseSafeSpawnSlot(player);
  player.x = slot.x; player.z = slot.z; player.floor = 0; player.ry = Math.PI;
  player.dead = false;
  player.deadUntil = 0;
  player.invulnerableUntil = Date.now() + RESPAWN_INVULN_MS;
  // Always clear a small disc under the respawning player so when invuln
  // ends they aren't standing on enemy paint. Keeps respawn fair even when
  // an opponent has blanketed the whole spawn lobby.
  erasePaint(slot.x, slot.z, RESPAWN_CLEAR_RADIUS, 0);
  send(player, {
    type: 'respawn',
    x: player.x, z: player.z, floor: 0, ry: player.ry,
    invulnerableMs: RESPAWN_INVULN_MS,
    clearRadius: RESPAWN_CLEAR_RADIUS,
  });
  broadcast({
    type: 'playerRespawn',
    id: player.id, x: player.x, z: player.z, floor: 0, ry: player.ry,
    invulnerableMs: RESPAWN_INVULN_MS,
    clearRadius: RESPAWN_CLEAR_RADIUS,
  }, player.id);
}

// ----- Phase transitions -----
function startCountdown() {
  if (phase !== 'lobby' && phase !== 'ended') return;
  if (players.size < 1) return;
  clearGrids();
  let i = 0;
  for (const p of players.values()) {
    const sp = spawnPosition(i++);
    p.x = sp.x; p.z = sp.z; p.floor = 0; p.ry = sp.ry;
    p.dead = false; p.deadUntil = 0; p.invulnerableUntil = 0;
    p.ready = false;       // ready state is round-scoped; reset for the next lobby
    console.log(`[spawn] countdown id=${p.id} slotIdx=${i-1} → (${sp.x},${sp.z}) ry=${sp.ry.toFixed(2)}`);
  }
  phase = 'countdown';
  phaseEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  broadcast({
    type: 'phase', phase, endsAt: phaseEndsAt,
    duration: COUNTDOWN_SECONDS,
    players: [...players.values()].map(publicPlayer),
  });
}

// Start the round automatically once every connected player has clicked
// Ready in the lobby. Single-player practice still works (1/1 ready → go).
function checkAllReady() {
  if (phase !== 'lobby' && phase !== 'ended') return;
  if (players.size < 1) return;
  for (const p of players.values()) if (!p.ready) return;
  startCountdown();
}

function startRound() {
  phase = 'playing';
  phaseEndsAt = Date.now() + ROUND_SECONDS * 1000;
  broadcast({ type: 'phase', phase, endsAt: phaseEndsAt, duration: ROUND_SECONDS });
}

function endRound() {
  phase = 'ended';
  lastRanking = computeScores();
  phaseEndsAt = Date.now() + 8000;
  broadcast({ type: 'phase', phase, endsAt: phaseEndsAt, ranking: lastRanking });
}

function backToLobby() {
  phase = 'lobby';
  clearGrids();
  // Reset everyone's ready state — each round requires a fresh round of
  // confirmations.
  for (const p of players.values()) p.ready = false;
  broadcast({
    type: 'phase', phase,
    players: [...players.values()].map(publicPlayer),
  });
}

setInterval(() => {
  const now = Date.now();
  if (phase === 'countdown' && now >= phaseEndsAt) startRound();
  else if (phase === 'playing' && now >= phaseEndsAt) endRound();
  else if (phase === 'ended' && now >= phaseEndsAt) backToLobby();

  if (phase === 'playing') {
    for (const p of players.values()) {
      if (p.dead && now >= p.deadUntil) respawnPlayer(p);
    }
    broadcast({
      type: 'scores',
      remaining: Math.max(0, phaseEndsAt - now),
      scores: computeScores(),
    });
  } else if (phase === 'countdown') {
    // Push countdown ticks so the client doesn't depend on its rAF loop to
    // count down — hidden / throttled tabs would otherwise show only the
    // first number ("3") and then jump straight to playing.
    broadcast({
      type: 'countdownTick',
      remaining: Math.max(0, phaseEndsAt - now),
    });
  }
}, 250);

// ----- HTTP + WebSocket -----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  if (players.size >= PLAYER_COLORS.length) {
    ws.send(JSON.stringify({ type: 'rejected', reason: 'Server full' }));
    ws.close();
    return;
  }
  const id = nextId++;
  const color = pickColor();
  // Place new joiners in a south-hall lobby slot, not at the world origin
  // (which is inside the staircase footprint).
  const sp = spawnPosition(players.size);
  const player = {
    id, color, ws,
    name: `Player ${id}`,
    x: sp.x, z: sp.z, floor: sp.floor, ry: sp.ry,
    dead: false, deadUntil: 0, invulnerableUntil: 0,
    ready: false,
    lastMoveAt: 0, lastPaintAt: 0, lastFootprintAt: 0,
  };
  players.set(id, player);
  console.log(`[spawn] join id=${id} → slot=(${sp.x},${sp.z}) ry=${sp.ry.toFixed(2)} (sizeBefore=${players.size - 1})`);

  const welcomePlayers = [...players.values()].map(publicPlayer);
  console.log(`[spawn] welcome→id=${id} players=${JSON.stringify(welcomePlayers.map(p => ({id:p.id, x:p.x, z:p.z})))}`);
  send(player, {
    type: 'welcome',
    id, color, name: player.name,
    floorSize: FLOOR_SIZE, floor2Y: FLOOR2_Y,
    ramp: { xMin: RAMP_X_MIN, xMax: RAMP_X_MAX, zMin: RAMP_Z_BOTTOM, zMax: RAMP_Z_TOP },
    grid: GRID,
    players: welcomePlayers,
    phase, phaseEndsAt,
    ranking: lastRanking,
    respawnSeconds: RESPAWN_SECONDS,
  });
  broadcast({ type: 'playerJoin', player: publicPlayer(player) }, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'name' && typeof msg.name === 'string') {
      player.name = msg.name.slice(0, 16) || player.name;
      broadcast({ type: 'playerName', id: player.id, name: player.name });
      return;
    }

    if (msg.type === 'move') {
      if (player.dead) return;
      const now = Date.now();
      if (now - player.lastMoveAt < 30) return;
      player.lastMoveAt = now;
      const nx = clamp(+msg.x, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const nz = clamp(+msg.z, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const ry = +msg.ry || 0;
      const reqFloor = Number.isFinite(+msg.floor) ? Math.max(0, Math.min(FLOORS - 1, +msg.floor)) : player.floor;

      // Death check (only on actual floor surfaces, not ramp). Skip while
      // the player has post-respawn invulnerability so they don't get
      // re-killed by the next move tick if they respawned onto enemy paint.
      if (phase === 'playing' && !isOnRamp(nx, nz) && Date.now() >= (player.invulnerableUntil || 0)) {
        const colorId = sampleColorAt(nx, nz, reqFloor);
        if (colorId !== 0 && colorId !== player.id) {
          killPlayer(player, colorId);
          return;
        }
      }

      const ny = clamp(+msg.y || 0, 0, FLOOR2_Y + 1);
      player.x = nx; player.y = ny; player.z = nz;
      player.floor = reqFloor; player.ry = ry;
      broadcast({
        type: 'playerMove',
        id: player.id, x: nx, y: ny, z: nz, ry, floor: reqFloor,
      }, player.id);
      return;
    }

    if (msg.type === 'paint' && phase === 'playing') {
      if (player.dead) return;
      const now = Date.now();
      if (now - player.lastPaintAt < 30) return;
      player.lastPaintAt = now;
      const x = clamp(+msg.x, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const z = clamp(+msg.z, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const r = clamp(+msg.r || 0.6, 0.1, 1.5);
      const floor = Number.isFinite(+msg.floor) ? Math.max(0, Math.min(FLOORS - 1, +msg.floor)) : player.floor;
      // Optional stroke endpoint: paint a continuous line from (fromX, fromZ)
      // on (fromFloor) up to (x, z) on `floor` — only if same floor and the
      // distance is plausible (less than 6 m of movement in one tick).
      const fromX = +msg.fromX, fromZ = +msg.fromZ;
      const fromFloor = Number.isFinite(+msg.fromFloor) ? +msg.fromFloor : floor;
      if (Number.isFinite(fromX) && Number.isFinite(fromZ) && fromFloor === floor) {
        const dx = x - fromX, dz = z - fromZ;
        const d = Math.hypot(dx, dz);
        if (d > 0.05 && d < 6) {
          const stepLen = r * 0.5;
          const steps = Math.max(1, Math.ceil(d / stepLen));
          for (let i = 1; i < steps; i++) {
            const t = i / steps;
            stampPaint(player.id, fromX + dx * t, fromZ + dz * t, r, floor);
          }
        }
      }
      stampPaint(player.id, x, z, r, floor);
      broadcast({
        type: 'paint',
        id: player.id, x, z, r, floor,
        fromX: Number.isFinite(fromX) ? fromX : null,
        fromZ: Number.isFinite(fromZ) ? fromZ : null,
        fromFloor: Number.isFinite(fromFloor) ? fromFloor : null,
      });
      return;
    }

    if (msg.type === 'footprint' && phase === 'playing') {
      if (player.dead) return;
      const now = Date.now();
      if (now - player.lastFootprintAt < 60) return;
      player.lastFootprintAt = now;
      const x = clamp(+msg.x, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const z = clamp(+msg.z, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const r = clamp(+msg.r || 0.32, 0.15, 0.5);
      const floor = Number.isFinite(+msg.floor) ? Math.max(0, Math.min(FLOORS - 1, +msg.floor)) : player.floor;
      const fromX = +msg.fromX, fromZ = +msg.fromZ;
      const fromFloor = Number.isFinite(+msg.fromFloor) ? +msg.fromFloor : floor;
      if (Number.isFinite(fromX) && Number.isFinite(fromZ) && fromFloor === floor) {
        const dx = x - fromX, dz = z - fromZ;
        const d = Math.hypot(dx, dz);
        if (d > 0.05 && d < 4) {
          const stepLen = r * 0.5;
          const steps = Math.max(1, Math.ceil(d / stepLen));
          for (let i = 1; i < steps; i++) {
            const t = i / steps;
            stampPaint(player.id, fromX + dx * t, fromZ + dz * t, r, floor);
          }
        }
      }
      stampPaint(player.id, x, z, r, floor);
      broadcast({
        type: 'footprint', id: player.id, x, z, r, floor,
        fromX: Number.isFinite(fromX) ? fromX : null,
        fromZ: Number.isFinite(fromZ) ? fromZ : null,
        fromFloor: Number.isFinite(fromFloor) ? fromFloor : null,
      });
      return;
    }

    if (msg.type === 'decal' && phase === 'playing') {
      if (player.dead) return;
      const now = Date.now();
      if (now - player.lastPaintAt < 50) return;
      player.lastPaintAt = now;
      broadcast({
        type: 'decal',
        id: player.id,
        x: +msg.x, y: +msg.y, z: +msg.z,
        nx: +msg.nx, ny: +msg.ny, nz: +msg.nz,
        r: clamp(+msg.r || 1.1, 0.2, 2.5),
      }, player.id);
      return;
    }

    if (msg.type === 'ready') {
      if (phase !== 'lobby' && phase !== 'ended') return;
      if (player.ready) return;
      player.ready = true;
      broadcast({ type: 'playerReady', id: player.id, ready: true });
      checkAllReady();
      return;
    }

    if (msg.type === 'unready') {
      if (phase !== 'lobby' && phase !== 'ended') return;
      if (!player.ready) return;
      player.ready = false;
      broadcast({ type: 'playerReady', id: player.id, ready: false });
      return;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'playerLeave', id });
    if (players.size === 0) {
      phase = 'lobby';
      clearGrids();
    } else {
      // The player who just left may have been the last hold-out keeping
      // the lobby from launching. Re-check.
      checkAllReady();
    }
  });
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

server.listen(PORT, () => {
  console.log(`Paint House server running at http://localhost:${PORT}`);
});
