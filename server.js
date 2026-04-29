const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Game configuration
const FLOOR_SIZE = 30;        // meters (square floor centered at origin)
const GRID = 256;             // server-side area grid resolution
const ROUND_SECONDS = 60;
const COUNTDOWN_SECONDS = 3;

// Distinct hues for up to 8 players (HSL strings, also used by clients)
const PLAYER_COLORS = [
  '#ff3b6b', // red-pink
  '#36c2ff', // cyan
  '#ffd23a', // yellow
  '#7bff5c', // green
  '#a85cff', // purple
  '#ff8a3a', // orange
  '#3affd4', // mint
  '#ff5cf0', // magenta
];

// ----- Game state -----
const players = new Map(); // id -> { id, name, color, ws, x, z, ry, alive }
let nextId = 1;

let phase = 'lobby';   // 'lobby' | 'countdown' | 'playing' | 'ended'
let phaseEndsAt = 0;   // ms timestamp
let lastRanking = null;

// 2D grid: each cell holds player id (0 = unpainted)
const grid = new Uint8Array(GRID * GRID);

function clearGrid() {
  grid.fill(0);
}

function worldToCell(x, z) {
  // x,z in [-FLOOR_SIZE/2, FLOOR_SIZE/2]
  const u = (x + FLOOR_SIZE / 2) / FLOOR_SIZE;
  const v = (z + FLOOR_SIZE / 2) / FLOOR_SIZE;
  const cx = Math.floor(u * GRID);
  const cz = Math.floor(v * GRID);
  return { cx, cz };
}

function stampPaint(playerId, x, z, r) {
  // r in meters → cells
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

function sampleColorAt(x, z) {
  const { cx, cz } = worldToCell(x, z);
  if (cx < 0 || cx >= GRID || cz < 0 || cz >= GRID) return 0;
  return grid[cz * GRID + cx];
}

function computeScores() {
  // count cells per player id
  const counts = new Map();
  for (let i = 0; i < grid.length; i++) {
    const id = grid[i];
    if (id === 0) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const total = GRID * GRID;
  const result = [];
  for (const [id, c] of counts) {
    const player = players.get(id);
    if (!player) continue;
    result.push({
      id,
      name: player.name,
      color: player.color,
      cells: c,
      percent: (c / total) * 100,
    });
  }
  // include zero-score players too
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
  return { id: p.id, name: p.name, color: p.color, x: p.x, z: p.z, ry: p.ry };
}

function pickColor() {
  const used = new Set([...players.values()].map(p => p.color));
  for (const c of PLAYER_COLORS) if (!used.has(c)) return c;
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

// ----- Phase transitions -----
function startCountdown() {
  if (phase !== 'lobby' && phase !== 'ended') return;
  if (players.size < 1) return;
  clearGrid();
  // Spread players to spawn positions
  const n = players.size;
  let i = 0;
  for (const p of players.values()) {
    const angle = (i / n) * Math.PI * 2;
    p.x = Math.cos(angle) * (FLOOR_SIZE * 0.3);
    p.z = Math.sin(angle) * (FLOOR_SIZE * 0.3);
    p.ry = angle + Math.PI;
    i++;
  }
  phase = 'countdown';
  phaseEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  broadcast({
    type: 'phase',
    phase,
    endsAt: phaseEndsAt,
    duration: COUNTDOWN_SECONDS,
    players: [...players.values()].map(publicPlayer),
  });
}

function startRound() {
  phase = 'playing';
  phaseEndsAt = Date.now() + ROUND_SECONDS * 1000;
  broadcast({
    type: 'phase',
    phase,
    endsAt: phaseEndsAt,
    duration: ROUND_SECONDS,
  });
}

function endRound() {
  phase = 'ended';
  lastRanking = computeScores();
  phaseEndsAt = Date.now() + 8000;
  broadcast({
    type: 'phase',
    phase,
    endsAt: phaseEndsAt,
    ranking: lastRanking,
  });
}

function backToLobby() {
  phase = 'lobby';
  clearGrid();
  broadcast({ type: 'phase', phase });
}

// Server tick
setInterval(() => {
  const now = Date.now();
  if (phase === 'countdown' && now >= phaseEndsAt) startRound();
  else if (phase === 'playing' && now >= phaseEndsAt) endRound();
  else if (phase === 'ended' && now >= phaseEndsAt) backToLobby();

  if (phase === 'playing') {
    // periodic score snapshot
    broadcast({
      type: 'scores',
      remaining: Math.max(0, phaseEndsAt - now),
      scores: computeScores(),
    });
  }
}, 500);

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
  const player = {
    id, color, ws,
    name: `玩家${id}`,
    x: 0, z: 0, ry: 0,
    lastMoveAt: 0, lastPaintAt: 0,
  };
  players.set(id, player);

  send(player, {
    type: 'welcome',
    id, color,
    name: player.name,
    floorSize: FLOOR_SIZE,
    grid: GRID,
    players: [...players.values()].map(publicPlayer),
    phase,
    phaseEndsAt,
    ranking: lastRanking,
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
      const now = Date.now();
      if (now - player.lastMoveAt < 30) return;
      player.lastMoveAt = now;
      const nx = clamp(+msg.x, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const nz = clamp(+msg.z, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const ry = +msg.ry || 0;
      // During play: prevent moving onto enemy color
      if (phase === 'playing') {
        const colorId = sampleColorAt(nx, nz);
        if (colorId !== 0 && colorId !== player.id) {
          // reject move; tell client where they actually are
          send(player, { type: 'snapBack', x: player.x, z: player.z });
          return;
        }
      }
      player.x = nx; player.z = nz; player.ry = ry;
      broadcast({
        type: 'playerMove',
        id: player.id, x: nx, z: nz, ry,
      }, player.id);
      return;
    }

    if (msg.type === 'paint' && phase === 'playing') {
      const now = Date.now();
      if (now - player.lastPaintAt < 50) return;
      player.lastPaintAt = now;
      const x = clamp(+msg.x, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const z = clamp(+msg.z, -FLOOR_SIZE / 2, FLOOR_SIZE / 2);
      const r = clamp(+msg.r || 0.6, 0.1, 1.5);
      stampPaint(player.id, x, z, r);
      broadcast({ type: 'paint', id: player.id, x, z, r });
      return;
    }

    if (msg.type === 'decal' && phase === 'playing') {
      const now = Date.now();
      if (now - player.lastPaintAt < 50) return;
      player.lastPaintAt = now;
      // Decals are visual-only; no grid update, just rebroadcast to others.
      broadcast({
        type: 'decal',
        id: player.id,
        x: +msg.x, y: +msg.y, z: +msg.z,
        nx: +msg.nx, ny: +msg.ny, nz: +msg.nz,
        r: clamp(+msg.r || 1.1, 0.2, 2.5),
      }, player.id);
      return;
    }

    if (msg.type === 'startRound') {
      if (phase === 'lobby' || phase === 'ended') startCountdown();
      return;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'playerLeave', id });
    if (players.size === 0) {
      phase = 'lobby';
      clearGrid();
    }
  });
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

server.listen(PORT, () => {
  console.log(`Paint House server running at http://localhost:${PORT}`);
});
