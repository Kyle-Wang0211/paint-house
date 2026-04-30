import * as THREE from 'three';

// Multi-floor floor painter. Each storey gets its own CanvasTexture (visual)
// and its own owner-id grid (for the death/walk-restriction sample).
export class Painter {
  constructor({ floorSize, floors, floorYs, resolution = 1024, gridResolution = 256 }) {
    this.floorSize = floorSize;
    this.floors = floors;
    this.resolution = resolution;
    this.gridResolution = gridResolution;
    this.floorYs = floorYs;       // array of length `floors`

    this.canvases = [];
    this.ctxs = [];
    this.textures = [];
    this.meshes = [];
    this.grids = [];

    for (let f = 0; f < floors; f++) {
      const c = document.createElement('canvas');
      c.width = resolution; c.height = resolution;
      const ctx = c.getContext('2d');
      this.canvases.push(c);
      this.ctxs.push(ctx);

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      this.textures.push(tex);

      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.65,
        metalness: 0.0,
        transparent: true,
      });
      const geo = new THREE.PlaneGeometry(floorSize, floorSize, 1, 1);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = floorYs[f] + 0.012;
      mesh.receiveShadow = true;
      mesh.userData.floor = f;
      this.meshes.push(mesh);

      this.grids.push(new Uint8Array(gridResolution * gridResolution));
    }
  }

  // Convenience: get all the floor meshes (for raycaster / scene.add).
  getMeshes() { return this.meshes; }
  meshForFloor(f) { return this.meshes[f]; }

  reset() {
    for (let f = 0; f < this.floors; f++) {
      this.ctxs[f].clearRect(0, 0, this.resolution, this.resolution);
      this.grids[f].fill(0);
      this.textures[f].needsUpdate = true;
    }
  }

  worldToPx(x, z) {
    const u = (x + this.floorSize / 2) / this.floorSize;
    const v = (z + this.floorSize / 2) / this.floorSize;
    return { px: u * this.resolution, py: v * this.resolution };
  }

  worldToCell(x, z) {
    const u = (x + this.floorSize / 2) / this.floorSize;
    const v = (z + this.floorSize / 2) / this.floorSize;
    return {
      cx: Math.floor(u * this.gridResolution),
      cz: Math.floor(v * this.gridResolution),
    };
  }

  paint(x, z, radiusMeters, colorHex, ownerId, floorIdx) {
    if (floorIdx < 0 || floorIdx >= this.floors) return;
    const ctx = this.ctxs[floorIdx];
    const { px, py } = this.worldToPx(x, z);
    const rPx = (radiusMeters / this.floorSize) * this.resolution;

    const grad = ctx.createRadialGradient(px, py, 0, px, py, rPx);
    grad.addColorStop(0, this.colorWithAlpha(colorHex, 1.0));
    grad.addColorStop(0.7, this.colorWithAlpha(colorHex, 0.92));
    grad.addColorStop(1, this.colorWithAlpha(colorHex, 0));
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, rPx, 0, Math.PI * 2);
    ctx.fill();

    const grid = this.grids[floorIdx];
    const cellsPerMeter = this.gridResolution / this.floorSize;
    const rc = radiusMeters * cellsPerMeter * 0.85;
    const { cx, cz } = this.worldToCell(x, z);
    const r2 = rc * rc;
    const minX = Math.max(0, Math.floor(cx - rc));
    const maxX = Math.min(this.gridResolution - 1, Math.ceil(cx + rc));
    const minZ = Math.max(0, Math.floor(cz - rc));
    const maxZ = Math.min(this.gridResolution - 1, Math.ceil(cz + rc));
    for (let zi = minZ; zi <= maxZ; zi++) {
      for (let xi = minX; xi <= maxX; xi++) {
        const dx = xi - cx;
        const dz = zi - cz;
        if (dx * dx + dz * dz <= r2) {
          grid[zi * this.gridResolution + xi] = ownerId;
        }
      }
    }

    this.textures[floorIdx].needsUpdate = true;
  }

  // Erase paint inside a circle (visual + ownership grid). Used to mirror
  // server-side respawn-clear so a respawning player isn't standing on
  // enemy paint that the rest of the lobby is blanketed with.
  erase(x, z, radiusMeters, floorIdx) {
    if (floorIdx < 0 || floorIdx >= this.floors) return;
    const ctx = this.ctxs[floorIdx];
    const { px, py } = this.worldToPx(x, z);
    const rPx = (radiusMeters / this.floorSize) * this.resolution;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(px, py, rPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    const grid = this.grids[floorIdx];
    const cellsPerMeter = this.gridResolution / this.floorSize;
    const rc = radiusMeters * cellsPerMeter;
    const { cx, cz } = this.worldToCell(x, z);
    const r2 = rc * rc;
    const minX = Math.max(0, Math.floor(cx - rc));
    const maxX = Math.min(this.gridResolution - 1, Math.ceil(cx + rc));
    const minZ = Math.max(0, Math.floor(cz - rc));
    const maxZ = Math.min(this.gridResolution - 1, Math.ceil(cz + rc));
    for (let zi = minZ; zi <= maxZ; zi++) {
      for (let xi = minX; xi <= maxX; xi++) {
        const dx = xi - cx;
        const dz = zi - cz;
        if (dx * dx + dz * dz <= r2) {
          grid[zi * this.gridResolution + xi] = 0;
        }
      }
    }
    this.textures[floorIdx].needsUpdate = true;
  }

  ownerAt(x, z, floorIdx) {
    if (floorIdx < 0 || floorIdx >= this.floors) return 0;
    const grid = this.grids[floorIdx];
    const { cx, cz } = this.worldToCell(x, z);
    if (cx < 0 || cx >= this.gridResolution || cz < 0 || cz >= this.gridResolution) return 0;
    return grid[cz * this.gridResolution + cx];
  }

  colorWithAlpha(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
}
